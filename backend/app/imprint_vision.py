"""Read a pill's imprint with a Claude vision model.

Tesseract is a document OCR engine: it does poorly on tiny embossed or
debossed characters on a curved, shiny pill, and imprint_match's token
filter drops single characters entirely (so "L" / "5" can never be read).
A vision model reads these much more reliably.

The read is only a suggestion: the app pre-fills it into the imprint boxes
and the user confirms or corrects it before it's used for matching.

Enabled when an Anthropic credential is configured (ANTHROPIC_API_KEY);
otherwise read_imprint_with_vision() returns None and callers fall back to
Tesseract. Note this sends the pill photo to the Anthropic API.
"""
from __future__ import annotations

import base64
import io
import json
import os
from typing import Optional

from PIL import Image

try:
    import anthropic
except ImportError:  # optional dependency; Tesseract fallback still works
    anthropic = None

_PROMPT = (
    "Each image is a close-up photo of one side of the same pill (the first image is side 1, "
    "the second, if present, is side 2). Read the imprint on each side: the letters, numbers or "
    "symbols that are printed, embossed or debossed on the pill. Report exactly what is "
    "legible, in reading order, with separate groups separated by a space (e.g. \"M 30\"). "
    "Ignore score lines and anything in the background that is not on the pill. If a side has "
    "no imprint, or you cannot read it with confidence, return an empty string for that side. "
    "Do not guess a likely imprint from the pill's appearance."
)

_SCHEMA = {
    "type": "object",
    "properties": {
        "side_1": {"type": "string"},
        "side_2": {"type": "string"},
    },
    "required": ["side_1", "side_2"],
    "additionalProperties": False,
}

_client = None


def vision_available() -> bool:
    return anthropic is not None and bool(os.environ.get("ANTHROPIC_API_KEY"))


def _get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=30.0, max_retries=1)
    return _client


def _jpeg_b64(image: Image.Image, max_side: int = 1024) -> str:
    img = image.copy()
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return base64.standard_b64encode(buf.getvalue()).decode("utf-8")


def read_imprint_with_vision(images: list[Image.Image], model: str) -> Optional[tuple[str, str]]:
    """(side_1, side_2) as read by the model, "" where nothing legible; None
    if vision isn't configured or the call failed for any reason."""
    if not vision_available() or not images:
        return None
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": _jpeg_b64(img)}}
        for img in images[:2]
    ]
    content.append({"type": "text", "text": _PROMPT})
    try:
        response = _get_client().beta.messages.create(
            model=model,
            max_tokens=4000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SCHEMA}},
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.APIConnectionError as e:
        print(f"[imprint_vision] Network error, falling back to Tesseract: {e}")
        return None
    except anthropic.APIStatusError as e:
        print(f"[imprint_vision] API error {e.status_code}, falling back to Tesseract: {e.message}")
        return None
    if response.stop_reason != "end_turn":
        print(f"[imprint_vision] No usable read (stop_reason={response.stop_reason}).")
        return None
    text = next((b.text for b in response.content if b.type == "text"), None)
    try:
        data = json.loads(text or "")
    except json.JSONDecodeError:
        return None
    side_2 = data.get("side_2", "").strip() if len(images) > 1 else ""
    return data.get("side_1", "").strip(), side_2
