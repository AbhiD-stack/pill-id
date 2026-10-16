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

from PIL import Image

HERE = Path(__file__).resolve().parent
MAPPING_PATH = HERE / "dailymed_thumbnail_filenames.json"
OUT_DIR = HERE.parent / "app" / "data" / "thumbnails"


def _looks_like_photo(path: Path) -> bool:
    """Best-effort filter against chemical-structure diagrams and
    text/NDC-label-only images -- DailyMed's "package label" section
    (what these images come from) is supposed to be a photo of the box/
    bottle, but in practice sometimes contains a structural formula
    diagram or plain label artwork instead, which is actively misleading
    shown as "here's what your pill looks like." Both of those are
    overwhelmingly white background with thin black line art or text,
    unlike a photographed package or pill (which has filled color regions
    even on a white background). Not perfect -- a plain white pill alone
    could still get excluded, and some mostly-white label art could still
    slip through -- but better to skip a handful of good images than show
    a chemical structure where a pill clearly isn't recognizable."""
    try:
        img = Image.open(path).convert("RGB")
        img.thumbnail((100, 100))  # downsample for speed; stats are stable at this size
        pixels = list(img.getdata())
    except Exception:
        return True  # can't tell -- don't block a copy over a read error

    near_white = sum(1 for r, g, b in pixels if r > 235 and g > 235 and b > 235)
    saturations = [0 if max(r, g, b) == 0 else (max(r, g, b) - min(r, g, b)) / max(r, g, b) for r, g, b in pixels]

    white_frac = near_white / len(pixels)
    avg_sat = sum(saturations) / len(saturations)

    # Overwhelmingly white AND overwhelmingly unsaturated (grayscale-like)
    # together is the signature of line art/text on a blank page -- a
    # colorful label or a pill itself breaks at least one of these.
    return not (white_frac > 0.80 and avg_sat < 0.08)


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
    skipped_non_photo = 0
    for label, filename in mapping.items():
        src = source_dir / filename
        if not src.exists():
            missing += 1
            continue
        if not _looks_like_photo(src):
            skipped_non_photo += 1
            continue
        dst = OUT_DIR / f"{label}.jpg"
        shutil.copyfile(src, dst)
        found += 1

    print(f"\nCopied {found} thumbnails to {OUT_DIR}")
    print(f"{missing} expected files were not found in that folder (skipped, not fatal).")
    print(f"{skipped_non_photo} looked like a chemical structure diagram or text/label image, "
          "not an actual pill/package photo -- skipped (better no image than a misleading one).")
    print("\nDone -- this folder is local only, nothing to commit. Just restart the backend.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
