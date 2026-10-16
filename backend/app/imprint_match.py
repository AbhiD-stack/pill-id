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


def read_imprint_text(image: Image.Image) -> Optional[str]:
    """Best-effort OCR read of the query image. Returns None if OCR is unavailable
    or nothing legible was found above the confidence floor."""
    if pytesseract is None:
        return None
    try:
        processed = _preprocess_for_ocr(image)
    except Exception:
        return None
    tokens: set[str] = set()
    for psm in _PSM_MODES:
        tokens |= _ocr_tokens(processed, psm)
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
