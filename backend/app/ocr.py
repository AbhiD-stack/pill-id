"""Server-side OCR for pill-bottle labels (V3).

Privacy note: a bottle label photo can contain the patient's name, address,
prescriber, and pharmacy -- meaningfully more sensitive than a bare pill
photo. This module (and the /api/ocr-label route that calls it) processes
the uploaded image entirely in memory and never writes it to disk or a log;
the response is the extracted text plus catalog matches, nothing more. This
app has no IRB review and is not a HIPAA-covered entity's system -- treat it
as an experimental pilot, not a compliance-reviewed medical product.

Requires the `tesseract-ocr` system binary (see Dockerfile / README) plus the
`pytesseract` Python package. Both are optional at import time so a
deployment without them still starts; the endpoint just returns a clear
"OCR unavailable" error instead of crashing the whole app.
"""
from __future__ import annotations

import re
from typing import List, Optional

from PIL import Image

from catalog import CatalogEntry, MedicationCatalog

_STOPWORDS = {
    "tablets", "tablet", "capsules", "capsule", "mg", "mcg", "ml", "take",
    "daily", "twice", "with", "food", "water", "refill", "qty", "rx", "no",
    "the", "and", "for", "each", "one", "two", "three", "as", "needed",
    "by", "mouth", "pharmacy", "store", "at", "room", "temperature",
}


def is_available() -> bool:
    try:
        import pytesseract  # noqa: F401

        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


def extract_label_text(image: Image.Image) -> str:
    """OCR the bottle-label image. Raises RuntimeError if OCR isn't installed."""
    try:
        import pytesseract
    except ImportError as e:
        raise RuntimeError(
            "OCR is not installed on this server (missing pytesseract)."
        ) from e
    try:
        return pytesseract.image_to_string(image)
    except pytesseract.TesseractNotFoundError as e:
        raise RuntimeError(
            "OCR is not installed on this server (missing the tesseract-ocr binary)."
        ) from e


def _candidate_phrases(raw_text: str) -> List[str]:
    """Pull out plausible drug-name phrases from noisy OCR text.

    Bottle labels mix patient info, dosage instructions, and the drug name in
    no fixed layout, so rather than trying to locate "the" drug name line, we
    generate a handful of candidate phrases (individual words + adjacent word
    pairs) and let catalog.search_by_name score each against the real
    medication names -- noise words just won't match anything.
    """
    words = re.findall(r"[A-Za-z][A-Za-z\-]{2,}", raw_text)
    words = [w for w in words if w.lower() not in _STOPWORDS]
    phrases: List[str] = []
    for i, w in enumerate(words):
        phrases.append(w)
        if i + 1 < len(words):
            phrases.append(f"{w} {words[i + 1]}")
    # Longest phrases first -- a two-word brand match is more meaningful than
    # a single common word matching by coincidence.
    return sorted(set(phrases), key=len, reverse=True)


def suggest_candidates_from_text(
    raw_text: str, catalog: MedicationCatalog, limit: int = 10
) -> List[CatalogEntry]:
    seen_labels = set()
    out: List[CatalogEntry] = []
    for phrase in _candidate_phrases(raw_text):
        if len(out) >= limit:
            break
        for entry in catalog.search_by_name(phrase, limit=5):
            if entry.label in seen_labels:
                continue
            seen_labels.add(entry.label)
            out.append(entry)
            if len(out) >= limit:
                break
    return out
