"""Serve reference pill thumbnails out of one or more dataset zips.

The reference image paths stored in the model artifacts are absolute paths from
the original training environment (Colab). We map them to their location inside
the matching local dataset zip and read the bytes on demand. Each underlying
ZipFile handle is shared behind a lock (zip reads are not thread-safe).

Supports multiple reference-image sources so a single deployment can serve
thumbnails from more than one database (e.g. the ePillID dataset plus an
OTC/DailyMed reference set) without code changes beyond adding the new zip's
root folder name here.
"""
from __future__ import annotations

import threading
import zipfile
from pathlib import Path, PurePosixPath
from typing import Dict, Optional, Tuple

_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}

# Top-level folder name each zip is rooted at. Add an entry here (and pass the
# corresponding zip path into ReferenceImageStore) whenever a new reference
# database is added.
KNOWN_ROOTS = ("ePillID_data", "otc_data")


def map_to_zip_path(stored_path: str) -> str:
    """Translate a stored absolute reference path to its path inside a zip.

    Each dataset zip is rooted at one of KNOWN_ROOTS, so we keep everything
    from that segment onward. Falls back to a normalized path if none of the
    known roots are present (e.g. legacy "extracted/..." ePillID paths).
    """
    parts = Path(stored_path.replace("\\", "/")).parts
    for root in KNOWN_ROOTS:
        if root in parts:
            idx = parts.index(root)
            return "/".join(parts[idx:])
    if "extracted" in parts:
        idx = parts.index("extracted")
        return "/".join(parts[idx + 1:])
    return stored_path.replace("\\", "/")


class ReferenceImageStore:
    """Aggregates one ZipFile per known reference-image root.

    `zip_paths` maps a root name (member of KNOWN_ROOTS) to the zip file that
    contains it. Missing/unconfigured roots are skipped rather than raising,
    so a deployment without the OTC zip yet still serves ePillID thumbnails.
    """

    def __init__(self, zip_paths: Dict[str, Path]):
        self._zips: Dict[str, zipfile.ZipFile] = {}
        self._names: Dict[str, set] = {}
        self._lock = threading.Lock()
        opened = []
        for root, zip_path in zip_paths.items():
            if zip_path is None or not Path(zip_path).exists():
                continue
            zf = zipfile.ZipFile(zip_path, "r")
            self._zips[root] = zf
            self._names[root] = set(zf.namelist())
            opened.append(root)
        if not opened:
            raise FileNotFoundError(
                f"No reference-image zips found among: {list(zip_paths.values())}"
            )
        print(f"[reference_images] Serving thumbnails from: {opened}")

    def _root_of(self, zip_path: str) -> Optional[str]:
        parts = PurePosixPath(zip_path).parts
        return parts[0] if parts and parts[0] in self._zips else None

    def has(self, zip_path: str) -> bool:
        root = self._root_of(zip_path)
        return root is not None and zip_path in self._names[root]

    def read(self, zip_path: str) -> Optional[Tuple[bytes, str]]:
        """Return (bytes, content_type) for a zip member, or None if missing.

        Guards against path traversal / arbitrary reads by requiring the path
        to be an exact member of one of the known archives, under a known root.
        """
        root = self._root_of(zip_path)
        if root is None:
            return None
        normalized = PurePosixPath(zip_path)
        if zip_path not in self._names[root]:
            return None
        content_type = _CONTENT_TYPES.get(normalized.suffix.lower(), "application/octet-stream")
        with self._lock:
            data = self._zips[root].read(zip_path)
        return data, content_type

    def close(self) -> None:
        for zf in self._zips.values():
            zf.close()
