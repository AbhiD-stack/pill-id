"""Run this LOCALLY (Windows) to build backend/app/data/thumbnails/:

  thumbnails/pill/{label}.jpg     real pill photos (C3PI, optional --c3pi
                                  folder): NLM's studio photos of the pill
                                  itself. Covers ~4.1k labels.
  thumbnails/package/{label}.jpg  the best DailyMed image per label
                                  (required --dailymed folder). DailyMed
                                  has almost no pill photos -- these are
                                  package/label art -- so every candidate
                                  is scored and the most pill-like one
                                  wins (and line art is rejected).

The backend shows a pill/ photo when one exists; otherwise the app draws
the pill from its shape/color/imprint and keeps the package/ image one tap
away.

Usage (from backend/, with .venv activated):
    python scripts/collect_thumbnails.py --dailymed "C:\\...\\dailymed_images"
    python scripts/collect_thumbnails.py --dailymed "C:\\...\\dailymed_images" --c3pi "C:\\...\\gallery\\600"
    python scripts/collect_thumbnails.py --dailymed "..." --preview 40

--preview N writes thumbnail_preview.html (open it in a browser) showing N
random labels with every candidate, its score, and which one was picked --
for eyeballing whether the scoring picks real pill photos.

The output folder is local-only (gitignored): run this, then restart the
backend. Nothing to commit.
"""
from __future__ import annotations

import argparse
import html
import json
import random
import re
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
DAILYMED_MAPPING = HERE / "dailymed_thumbnail_filenames.json"
C3PI_MAPPING = HERE / "c3pi_thumbnail_filenames.json"
OUT_DIR = HERE.parent / "app" / "data" / "thumbnails"
PILL_DIR = OUT_DIR / "pill"
PACKAGE_DIR = OUT_DIR / "package"
# Real pill photos found among the DailyMed images by the pill model itself
# (label -> filename in --dailymed; built from the gallery embeddings: an
# image whose nearest gallery neighbors are mostly real pill photos).
DM_PHOTOS_MAPPING = HERE / "dailymed_pill_photos.json"
DM_PILL_DIR = OUT_DIR / "dm_pill"
PREVIEW_PATH = HERE.parent / "thumbnail_preview.html"

_PACKAGING_NAME = re.compile(
    r"label|carton|package|pack\b|principal|pdp|panel|box|bottle|blister|container|"
    r"display|artwork|submission|insert|vial|tube|bag|pouch|case|outer|foil|sachet",
    re.I,
)
# "table(?!t)": "table" is a figure, but "tablet" is the pill itself.
_FIGURE_NAME = re.compile(r"fig|structure|struct|formula|chem|chart|graph|table(?!t)|diagram", re.I)
_PILL_NAME = re.compile(r"tablet|tab\b|capsule|cap\b|pill|caplet|softgel|lozenge|spl[-_ ]?image", re.I)

REJECT = -1e9


def score_image(path: str) -> float:
    """Higher = more like a photo of the pill itself. REJECT = unusable.

    A manufacturer product photo is typically one or a few compact pills on
    a plain, uniform background: few edges overall, a uniform border, and
    a colored or shaded object in the middle. Package/label art is edge-
    dense (text, barcodes, panels) and runs edge-to-edge; chemical-structure
    figures are near-binary black line art on white."""
    try:
        img = Image.open(path)
        img.draft("RGB", (160, 160))  # fast reduced-size JPEG decode
        img = img.convert("RGB")
        img.thumbnail((128, 128))
    except Exception:
        return REJECT

    w, h = img.size
    if w < 16 or h < 16:
        return REJECT
    px = img.load()
    gray = img.convert("L")
    gp = gray.load()
    n = w * h

    near_white = 0
    sat_sum = 0.0
    ink = 0  # non-white pixels
    ink_dark = 0  # ...that are dark (black lines/text)
    ink_sat_sum = 0.0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            mx, mn = max(r, g, b), min(r, g, b)
            s = (mx - mn) / mx if mx else 0.0
            sat_sum += s
            if mn > 225:
                near_white += 1
            else:
                ink += 1
                ink_sat_sum += s
                if gp[x, y] < 100:
                    ink_dark += 1
    white_frac = near_white / n
    avg_sat = sat_sum / n
    ink_sat = ink_sat_sum / ink if ink else 0.0
    ink_dark_frac = ink_dark / ink if ink else 0.0

    # Line art / text on a blank page (chemical structures, plain labels):
    # mostly white, and what isn't white is dark, colorless ink. A pill
    # photo on a light backdrop is also mostly white, but its non-white
    # pixels are colored (a colored pill) or soft light-gray shading (a
    # white pill's shadow/edges) -- not black ink.
    if white_frac > 0.70 and ink_sat < 0.12 and ink_dark_frac > 0.40:
        return REJECT

    # Edge density: text, barcodes, and panel borders light this up; a few
    # pills on a plain background barely do.
    edges = gray.filter(ImageFilter.FIND_EDGES).load()
    strong = sum(1 for y in range(1, h - 1) for x in range(1, w - 1) if edges[x, y] > 60)
    edge_density = strong / max(1, (w - 2) * (h - 2))

    # Border uniformity: how much of the outer ring matches the ring's own
    # median color -- a studio/product photo has a plain backdrop, package
    # art usually runs content to the edges.
    ring = []
    bw = max(2, w // 10)
    bh = max(2, h // 10)
    for y in range(h):
        for x in range(w):
            if x < bw or x >= w - bw or y < bh or y >= h - bh:
                ring.append(gp[x, y])
    ring.sort()
    med = ring[len(ring) // 2]
    border_uniform = sum(1 for v in ring if abs(v - med) < 18) / len(ring)

    # Something should actually be there: fraction of center pixels that
    # differ from the border background.
    cx0, cx1, cy0, cy1 = w // 4, 3 * w // 4, h // 4, 3 * h // 4
    center_total = max(1, (cx1 - cx0) * (cy1 - cy0))
    # Low threshold on purpose: a white pill on a light-gray backdrop only
    # differs from it by ~10-20 brightness levels.
    center_obj = sum(1 for y in range(cy0, cy1) for x in range(cx0, cx1) if abs(gp[x, y] - med) >= 10) / center_total
    if center_obj < 0.02:
        return REJECT  # effectively blank

    score = 1.5 * border_uniform - 4.0 * edge_density
    score += 0.4 * min(center_obj, 0.6)  # an object, but not an edge-to-edge one
    score += 0.3 * min(avg_sat, 0.5)  # colored pills / photos over grayscale art

    name = Path(path).name
    if _FIGURE_NAME.search(name):
        score -= 1.0
    if _PACKAGING_NAME.search(name):
        score -= 0.6
    if _PILL_NAME.search(name):
        score += 0.3
    return score


def _pick_for_label(args):
    label, candidates = args
    scored = [(score_image(p), p) for p in candidates]
    scored.sort(reverse=True)
    best_score, best_path = scored[0] if scored else (REJECT, None)
    return label, (best_path if best_score > REJECT else None), scored


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dailymed", required=True, type=Path, help="dailymed_images folder")
    ap.add_argument("--c3pi", type=Path, default=None, help="optional C3PI gallery/600 folder (real pill photos, preferred)")
    ap.add_argument("--preview", type=int, default=0, help="write an HTML preview for N random labels and stop")
    ap.add_argument("--workers", type=int, default=None)
    args = ap.parse_args()

    if not args.dailymed.is_dir():
        print(f"Not a directory: {args.dailymed}")
        return 1
    if args.c3pi is not None and not args.c3pi.is_dir():
        print(f"Not a directory: {args.c3pi}")
        return 1

    dm_map: dict[str, list[str]] = json.loads(DAILYMED_MAPPING.read_text())
    c3_map: dict[str, str] = json.loads(C3PI_MAPPING.read_text()) if args.c3pi else {}

    pill_photos: dict[str, Path] = {}
    if args.c3pi:
        for label, fname in c3_map.items():
            p = args.c3pi / fname
            if p.exists():
                pill_photos[label] = p
        print(f"C3PI: {len(pill_photos)} labels have a real studio pill photo.")

    jobs = []
    for label, names in dm_map.items():
        existing = [str(args.dailymed / n) for n in names if (args.dailymed / n).exists()]
        if existing:
            jobs.append((label, existing))

    if args.preview:
        random.seed(0)
        jobs = random.sample(jobs, min(args.preview, len(jobs)))
        print(f"Scoring {len(jobs)} sample labels for preview ...")
    else:
        print(f"Scoring DailyMed candidates for {len(jobs)} labels (this can take several minutes) ...")

    results = []
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for i, res in enumerate(ex.map(_pick_for_label, jobs, chunksize=64), 1):
            results.append(res)
            if i % 2000 == 0:
                print(f"  {i}/{len(jobs)}")

    if args.preview:
        rows = []
        for label, best, scored in results:
            cells = []
            for s, p in scored:
                is_best = p == best
                uri = Path(p).resolve().as_uri()
                tag = "REJECTED" if s <= REJECT else f"{s:.2f}"
                border = "4px solid #16a34a" if is_best else "1px solid #ccc"
                cells.append(
                    f'<div style="display:inline-block;margin:4px;text-align:center;font:11px sans-serif">'
                    f'<img src="{uri}" style="width:110px;height:110px;object-fit:contain;border:{border}"><br>'
                    f"{html.escape(tag)}<br>{html.escape(Path(p).name[:28])}</div>"
                )
            rows.append(f"<h3 style='font:14px sans-serif'>{html.escape(label)}</h3>{''.join(cells)}<hr>")
        PREVIEW_PATH.write_text("<html><body>" + "".join(rows) + "</body></html>", encoding="utf-8")
        print(f"\nWrote {PREVIEW_PATH} -- open it in a browser. Green border = picked.")
        return 0

    package: dict[str, Path] = {}
    rejected_all = 0
    for label, best, _ in results:
        if best:
            package[label] = Path(best)
        else:
            rejected_all += 1

    # Rebuild only the folders this script owns, so stale picks don't
    # linger -- other scripts' folders (label_pill/) are left alone.
    for d in (PILL_DIR, PACKAGE_DIR, DM_PILL_DIR):
        if d.exists():
            shutil.rmtree(d)
    for old in OUT_DIR.glob("*.jpg") if OUT_DIR.exists() else []:
        old.unlink()  # flat files from an older version of this script
    PILL_DIR.mkdir(parents=True, exist_ok=True)
    PACKAGE_DIR.mkdir(parents=True, exist_ok=True)
    DM_PILL_DIR.mkdir(parents=True, exist_ok=True)
    dm_photos = json.loads(DM_PHOTOS_MAPPING.read_text()) if DM_PHOTOS_MAPPING.exists() else {}
    dm_written = 0
    for label, fname in dm_photos.items():
        src = args.dailymed / fname
        if src.exists():
            try:
                Image.open(src).convert("RGB").save(DM_PILL_DIR / f"{label}.jpg", "JPEG", quality=90)
                dm_written += 1
            except Exception:
                pass
    for label, src in pill_photos.items():
        shutil.copyfile(src, PILL_DIR / f"{label}.jpg")
    for label, src in package.items():
        shutil.copyfile(src, PACKAGE_DIR / f"{label}.jpg")

    print(f"\nWrote {len(pill_photos)} real pill photos to {PILL_DIR}")
    print(f"Wrote {dm_written} real pill photos found in the DailyMed images to {DM_PILL_DIR}")
    print(f"Wrote {len(package)} package images to {PACKAGE_DIR}")
    print(f"  labels where every DailyMed candidate was rejected (line art/blank): {rejected_all}")
    print("\nDone -- local only, nothing to commit. Restart the backend.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
