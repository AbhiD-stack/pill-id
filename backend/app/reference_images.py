"""Serve reference pill thumbnails out of the ePillID dataset zip.

The reference image paths stored in the model artifacts are absolute paths from
the original training environment (Colab). We map them to their location inside
the local dataset zip and read the bytes on demand. A single ZipFile handle is
shared behind a lock (zip reads are not thread-safe).
"""
from __future__ import annotations

import threading
import zipfile
from pathlib import Path, PurePosixPath
from typing import Optional, Tuple

_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}


def map_to_zip_path(stored_path: str) -> str:
    """Translate a stored absolute reference path to its path inside the zip.

    The dataset zip is rooted at "ePillID_data/", so we keep everything from the
    "ePillID_data" segment onward. Falls back to a normalized path if that
    segment is absent.
    """
    parts = Path(stored_path.replace("\\", "/")).parts
    if "ePillID_data" in parts:
        idx = parts.index("ePillID_data")
        return "/".join(parts[idx:])
    if "extracted" in parts:
        idx = parts.index("extracted")
        return "/".join(parts[idx + 1:])
    return stored_path.replace("\\", "/")


class ReferenceImageStore:
    def __init__(self, zip_path: Path):
        if not zip_path.exists():
            raise FileNotFoundError(f"Dataset zip not found: {zip_path}")
        self._zip = zipfile.ZipFile(zip_path, "r")
        self._names = set(self._zip.namelist())
        self._lock = threading.Lock()

    def has(self, zip_path: str) -> bool:
        return zip_path in self._names

    def read(self, zip_path: str) -> Optional[Tuple[bytes, str]]:
        """Return (bytes, content_type) for a zip member, or None if missing.

        Guards against path traversal / arbitrary reads by requiring the path to
        be an exact member of the archive and to live under ePillID_data/.
        """
        normalized = PurePosixPath(zip_path)
        if normalized.parts and normalized.parts[0] != "ePillID_data":
            return None
        if zip_path not in self._names:
            return None
        content_type = _CONTENT_TYPES.get(normalized.suffix.lower(), "application/octet-stream")
        with self._lock:
            data = self._zip.read(zip_path)
        return data, content_type

    def close(self) -> None:
        self._zip.close()
