"""Imprint-text OCR and fuzzy matching against known reference imprints.

The embedding retrieval in classifier.py has no signal for what's actually
printed/debossed on the pill (it just measures overall visual similarity), so
two different drugs that happen to be the same shape/color are a coin flip.
This module reads whatever text is legible in the query photo and uses it to
re-rank the embedding candidates: a candidate whose known IMPRINT_CODE (from
RxNav, see build_ndc_names.py) shares tokens with the OCR read gets boosted;
one that contradicts it gets penalized.

OCR on phone photos of tiny embossed/debossed characters is unreliable, so
this is deliberately a soft signal (bounded fusion weight), not a hard filter.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Optional

from PIL import Image, ImageFilter, ImageOps

import os

try:
    import pytesseract

    # pytesseract looks for "tesseract" on PATH by default, which is a
    # common source of silent failure on Windows (the installer doesn't
    # always add itself to PATH, and a new PowerShell window is needed
    # either way for a PATH change to take effect). TESSERACT_CMD lets the
    # exact binary location be set explicitly instead of fighting PATH --
    # set it in backend/.env or via $env:TESSERACT_CMD if the automatic
    # PATH detection doesn't pick it up.
    _tesseract_cmd = os.environ.get("TESSERACT_CMD")
    if _tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = _tesseract_cmd
except ImportError:  # OCR is optional; degrade to embedding-only scoring.
    pytesseract = None

# EasyOCR: free, runs locally on the PyTorch the model already uses, and
# reads pill imprints far better than Tesseract -- measured on 150 real
# consumer pill photos from ePillID: 30% vs 4% got at least one imprint
# token right. Preferred when installed (`pip install easyocr`; it fetches
# its ~100 MB of model files once, on first use).
try:
    import easyocr
except ImportError:
    easyocr = None
_easy_reader = None
# Measured on the same 150 photos, with the known-imprint vocabulary filter
# read_imprint_text applies: 4 rotations -> 30% correct but 0.93 wrong
# tokens/photo; upright + upside-down -> 25% correct, 0.37 wrong, half the
# time. The read pre-fills boxes the user has to check, so fewer wrong
# suggestions beats a few more right ones.
_EASY_ROTATIONS = (0, 180)
_EASY_MIN_CONFIDENCE = 0.4
_EASY_LONG_SIDE = 800  # resize target: small crops upscaled, large ones shrunk for speed


def ocr_engine() -> str:
    if easyocr is not None:
        return "easyocr"
    return "tesseract" if pytesseract is not None else "none"


def _easyocr_tokens(image: Image.Image) -> set[str]:
    global _easy_reader
    import numpy as np
    if _easy_reader is None:
        _easy_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    scale = _EASY_LONG_SIDE / max(image.size)
    img = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    tokens: set[str] = set()
    for rot in _EASY_ROTATIONS:
        arr = np.array(img.rotate(rot, expand=True))
        for _, text, conf in _easy_reader.readtext(arr, allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"):
            if conf >= _EASY_MIN_CONFIDENCE:
                tokens.update(_TOKEN_RE.findall(text.upper()))
    return tokens

_TOKEN_RE = re.compile(r"[A-Z0-9]+")


def _normalize_tokens(text: str) -> set[str]:
    if not text:
        return set()
    return set(_TOKEN_RE.findall(text.upper()))


def _preprocess_for_ocr(image: Image.Image) -> Image.Image:
    """Upscale + grayscale + sharpen + autocontrast; embossed imprints are
    low-contrast and easily lost to blur at phone-camera distances."""
    gray = ImageOps.grayscale(image)
    w, h = gray.size
    scale = max(1, 1200 // max(w, h))
    if scale > 1:
        gray = gray.resize((w * scale, h * scale), Image.LANCZOS)
    gray = gray.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=3))
    return ImageOps.autocontrast(gray, cutoff=2)


# A single fixed layout assumption (--psm 11) was a frequent source of
# garbage reads (e.g. reading "CC SC" off a pill actually imprinted "575")
# -- different photos put the imprint in different positions/orientations
# relative to the frame, so trying a few layout assumptions and keeping
# only what Tesseract itself is confident about catches real imprints that
# a single mode misses, without just inventing more noise.
_PSM_MODES = ("11", "7", "6")  # sparse text / single line / uniform block
_MIN_CONFIDENCE = 40  # 0-100, Tesseract's own per-word confidence


def _ocr_tokens(processed: Image.Image, psm: str) -> set[str]:
    try:
        data = pytesseract.image_to_data(
            processed,
            config=f"--psm {psm} -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            output_type=pytesseract.Output.DICT,
        )
    except Exception:
        return set()
    tokens: set[str] = set()
    for text, conf in zip(data.get("text", []), data.get("conf", [])):
        try:
            if float(conf) < _MIN_CONFIDENCE:
                continue
        except (TypeError, ValueError):
            continue
        tokens.update(t for t in _TOKEN_RE.findall(text.upper()) if len(t) >= 2)
    return tokens


def _tesseract_tokens(image: Image.Image) -> set[str]:
    try:
        processed = _preprocess_for_ocr(image)
    except Exception:
        return set()
    tokens: set[str] = set()
    for psm in _PSM_MODES:
        tokens |= _ocr_tokens(processed, psm)
    return tokens


def read_imprint_text(image: Image.Image, vocab: Optional[set[str]] = None) -> Optional[str]:
    """Best-effort OCR read of the query image (EasyOCR if installed, else
    Tesseract). vocab, when given, keeps only tokens that appear in some
    known imprint -- OCR on a pill photo produces stray misreads, and a
    token no pill carries can't help identify one. Returns None if OCR is
    unavailable or nothing usable was read."""
    try:
        if easyocr is not None:
            tokens = _easyocr_tokens(image)
        elif pytesseract is not None:
            tokens = _tesseract_tokens(image)
        else:
            return None
    except Exception as e:
        print(f"[imprint_match] OCR failed: {e!r}")
        return None
    if vocab is not None:
        tokens = {t for t in tokens if t in vocab}
    return " ".join(sorted(tokens)) if tokens else None


@dataclass
class ImprintMatch:
    ocr_text: Optional[str]
    score: float  # in [0, 1]; 0 when no comparison was possible


def score_imprint_match(ocr_text: Optional[str], candidate_imprint: Optional[str]) -> ImprintMatch:
    """Fuzzy-compare OCR'd query text against a candidate's known imprint code.

    candidate_imprint is RxNav's IMPRINT_CODE, semicolon-separated, e.g.
    "LILLY;3229;40;mg". We tokenize both sides and score by token overlap plus
    a fuzzy string ratio, so partial/garbled OCR reads still contribute signal.
    """
    if not ocr_text or not candidate_imprint:
        return ImprintMatch(ocr_text=ocr_text, score=0.0)

    query_tokens = _normalize_tokens(ocr_text)
    cand_tokens = _normalize_tokens(candidate_imprint.replace(";", " "))
    if not query_tokens or not cand_tokens:
        return ImprintMatch(ocr_text=ocr_text, score=0.0)

    overlap = query_tokens & cand_tokens
    jaccard = len(overlap) / len(query_tokens | cand_tokens)

    # Fuzzy ratio catches near-misses OCR commonly makes (0/O, 1/I, 5/S).
    best_ratio = max(
        (SequenceMatcher(None, qt, ct).ratio() for qt in query_tokens for ct in cand_tokens),
        default=0.0,
    )

    raw_score = 0.6 * jaccard + 0.4 * best_ratio
    # Same characters, different spacing ("L5" typed vs "L;5" stored) is
    # the same imprint.
    if "".join(sorted(query_tokens)) == "".join(sorted(cand_tokens)) or \
            re.sub(r"[^A-Z0-9]", "", ocr_text.upper()) == "".join(_TOKEN_RE.findall(candidate_imprint.upper())):
        raw_score = 1.0
    return ImprintMatch(ocr_text=ocr_text, score=max(0.0, min(1.0, raw_score)))
