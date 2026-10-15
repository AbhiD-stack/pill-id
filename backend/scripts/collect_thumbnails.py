"""Run this LOCALLY (Windows) to build backend/app/data/thumbnails/ from
images you already have from the dailymed-acquisition Kaggle output.
Covers ~80% of all 31,277 labels (25,062 of them) -- every label with a
DailyMed-sourced image, not just the priority tier.

Needs: dailymed_thumbnail_filenames.json (committed alongside this script --
label -> expected filename, built server-side from image_manifest.csv) and
your local dailymed_images/ folder (the one inside
output\\dailymed_unzipped\\dailymed-acquisition-v2\\dailymed_images).

Usage (from the backend/ directory, with .venv activated):
    python scripts/collect_thumbnails.py "C:\\Users\\kvd_\\Downloads\\output\\dailymed_unzipped\\dailymed-acquisition-v2\\dailymed_images"

Copies (renaming to "<label>.jpg") whichever of the needed images it finds
into backend/app/data/thumbnails/ -- that's the folder the backend serves
reference thumbnails from. Safe to re-run.

This folder is local-only (gitignored) and deliberately NOT committed --
it's ~1.2GB, and your backend runs directly off this machine, so there's
nothing to push: just run this script, then restart the backend.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAPPING_PATH = HERE / "dailymed_thumbnail_filenames.json"
OUT_DIR = HERE.parent / "app" / "data" / "thumbnails"


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python collect_thumbnails.py <path to dailymed_images folder>")
        return 1

    source_dir = Path(sys.argv[1])
    if not source_dir.is_dir():
        print(f"Not a directory: {source_dir}")
        return 1

    mapping: dict[str, str] = json.loads(MAPPING_PATH.read_text())
    print(f"Looking for {len(mapping)} images in {source_dir} ...")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    found = 0
    missing = 0
    for label, filename in mapping.items():
        src = source_dir / filename
        if not src.exists():
            missing += 1
            continue
        dst = OUT_DIR / f"{label}.jpg"
        shutil.copyfile(src, dst)
        found += 1

    print(f"\nCopied {found} thumbnails to {OUT_DIR}")
    print(f"{missing} expected files were not found in that folder (skipped, not fatal).")
    print("\nDone -- this folder is local only, nothing to commit. Just restart the backend.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
