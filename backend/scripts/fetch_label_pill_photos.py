"""Find real pill photos inside each drug's official DailyMed label.

The earlier DailyMed download only took images from the package-label
section, which is almost all box/label art. But many manufacturers also put
a photo of the actual tablet/capsule elsewhere in the label (Description,
How Supplied). This script, for every pill that has no real photo yet:
  1. asks NIH RxNav for the NDC's DailyMed label id (SPL set id),
  2. lists every image in that label (DailyMed API),
  3. skips images whose names say package/carton/structure/etc.,
  4. downloads the rest and scores how pill-photo-like each one is
     (same scorer as collect_thumbnails.py),
  5. keeps the best image if it scores above --min-score.
Free, no keys. Resumable (downloads are cached). Run LOCALLY:

    cd backend
    python scripts/fetch_label_pill_photos.py --probe 60     # ~5 min: preview + yield
    python scripts/fetch_label_pill_photos.py                # all pills (an hour or more)

--probe writes backend/label_photo_preview.html: open it and check that the
images marked as picked are really pills, and that the score cutoff looks
right. Output: app/data/thumbnails/label_pill/{label}.jpg -- the backend
uses them (after C3PI and ePillID photos) on restart.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from collect_thumbnails import REJECT, score_image  # noqa: E402
from PIL import Image  # noqa: E402

BACKEND = HERE.parent
TODO = HERE / "pills_without_photo.json"
CACHE = BACKEND / "app" / "data" / "label_image_cache"
OUT_DIR = BACKEND / "app" / "data" / "thumbnails" / "label_pill"
PREVIEW = BACKEND / "label_photo_preview.html"
RXNAV = os.environ.get("RXNAV_BASE", "https://rxnav.nlm.nih.gov/REST")
DAILYMED = os.environ.get("DAILYMED_BASE", "https://dailymed.nlm.nih.gov/dailymed/services/v2")

# Image names that are not a photo of the pill, matched on whole words /
# word starts -- a plain substring test would throw away "tablet-5mg.png"
# because "tablet" contains "table".
_SKIP_PREFIXES = (
    "label", "carton", "packag", "principal", "pdp", "panel", "box", "bottle", "blister", "container",
    "display", "artwork", "structur", "formula", "chem", "figure", "chart", "graph", "diagram", "logo",
    "barcode", "insert", "vial", "tube", "pouch", "outer", "foil", "sachet", "tray",
)
_SKIP_WORDS = {"pack", "table", "tbl", "fig", "struct", "bag", "case", "kit", "inner", "pi", "ppi"}


def _skip_name(name: str) -> bool:
    words = re.findall(r"[a-z]+", name.lower())
    return any(w in _SKIP_WORDS or w.startswith(_SKIP_PREFIXES) for w in words)
_IMG_EXT = re.compile(r"\.(jpe?g|png|gif)$", re.I)
MAX_IMAGES_PER_LABEL = 12


def _get(url: str, *, raw: bool = False, tries: int = 4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pill-id/alpha (research)"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                return data if raw else json.loads(data)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
            time.sleep(2 ** attempt)
    return None


def _ndc_forms(ndc9: str) -> list[str]:
    """'00002-3228' -> ['00002-3228', '0002-3228'] (RxNav accepts several)."""
    a, b = ndc9.split("-")
    forms = [ndc9, f"{a.lstrip('0').zfill(4)}-{b}", f"{a}-{b.lstrip('0').zfill(3)}"]
    return list(dict.fromkeys(forms))


def spl_set_id(ndcs: list[str]) -> str | None:
    for n in ndcs:
        for form in _ndc_forms(n):
            data = _get(f"{RXNAV}/ndcproperties.json?id={urllib.parse.quote(form)}&ndcstatus=ALL")
            for p in ((data or {}).get("ndcPropertyList") or {}).get("ndcProperty") or []:
                if p.get("splSetIdItem"):
                    return p["splSetIdItem"]
                for c in (p.get("propertyConceptList") or {}).get("propertyConcept") or []:
                    if c.get("propName") == "SPL_SET_ID" and c.get("propValue"):
                        return c["propValue"]
    return None


def _find_media(obj) -> list[dict]:
    """Every {name, url} image entry anywhere in the media response."""
    found = []
    if isinstance(obj, dict):
        name, url = obj.get("name"), obj.get("url")
        if isinstance(name, str) and isinstance(url, str) and (_IMG_EXT.search(name) or "image" in str(obj.get("mime_type", ""))):
            found.append({"name": name, "url": url})
        for v in obj.values():
            found += _find_media(v)
    elif isinstance(obj, list):
        for v in obj:
            found += _find_media(v)
    return found


def label_images(setid: str) -> list[dict]:
    data = _get(f"{DAILYMED}/spls/{urllib.parse.quote(setid)}/media.json")
    media = _find_media(data) if data else []
    seen, out = set(), []
    for m in media:
        if m["name"] in seen or _skip_name(m["name"]):
            continue
        seen.add(m["name"])
        out.append(m)
    return out[:MAX_IMAGES_PER_LABEL]


def _download(setid: str, m: dict) -> Path | None:
    path = CACHE / re.sub(r"[^A-Za-z0-9_-]", "", setid) / re.sub(r"[^A-Za-z0-9._-]", "_", m["name"])
    if path.exists() and path.stat().st_size > 0:
        return path
    data = _get(m["url"], raw=True, tries=3)
    if not data or len(data) > 5_000_000:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def process(group: dict) -> dict:
    setid = spl_set_id(group["ndcs"])
    if not setid:
        return {"status": "no_label"}
    scored = []
    for m in label_images(setid):
        p = _download(setid, m)
        if p is not None:
            scored.append((score_image(str(p)), str(p)))
    scored.sort(reverse=True)
    return {"status": "ok", "setid": setid, "scored": scored}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", type=int, default=0, help="only N random pills, and write an HTML preview")
    ap.add_argument("--min-score", type=float, default=1.0, help="minimum pill-likeness score to keep an image")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    todo: dict[str, dict] = json.loads(TODO.read_text())
    groups = list(todo.items())
    if args.probe:
        random.seed(0)
        groups = random.sample(groups, min(args.probe, len(groups)))
    print(f"Looking for pill photos in the DailyMed labels of {len(groups)} pills...")
    print("Checking the connection...")
    if _get(f"{RXNAV}/version.json") is None or _get(f"{DAILYMED}/spls.json?pagesize=1") is None:
        print("Can't reach rxnav.nlm.nih.gov / dailymed.nlm.nih.gov -- check your internet connection.")
        return 1

    results: dict[str, dict] = {}
    lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process, g): key for key, g in groups}
        for i, fut in enumerate(as_completed(futures), 1):
            key = futures[fut]
            try:
                res = fut.result()
            except Exception as e:  # one bad label shouldn't stop the run
                res = {"status": f"error {e!r}"}
            with lock:
                results[key] = res
            if i % 100 == 0 or i == len(groups):
                kept = sum(1 for r in results.values() if r.get("scored") and r["scored"][0][0] >= args.min_score)
                print(f"  {i}/{len(groups)} pills checked, {kept} with a pill photo")

    labels_found = sum(1 for r in results.values() if r["status"] == "ok")
    with_imgs = sum(1 for r in results.values() if r.get("scored"))
    kept = {k: r for k, r in results.items() if r.get("scored") and r["scored"][0][0] >= args.min_score}
    print(f"\nDailyMed label found for {labels_found}/{len(groups)} pills; "
          f"{with_imgs} had candidate images; {len(kept)} pass the pill-photo score (>= {args.min_score}).")

    if args.probe:
        rows = []
        for key, r in sorted(results.items(), key=lambda kv: -(kv[1].get("scored") or [(REJECT,)])[0][0]):
            name = todo[key]["labels"][0]
            cells = []
            for i, (s, p) in enumerate(r.get("scored", [])):
                picked = i == 0 and s >= args.min_score
                border = "4px solid #16a34a" if picked else "1px solid #ccc"
                tag = "REJECTED" if s <= REJECT else f"{s:.2f}"
                cells.append(
                    f'<div style="display:inline-block;margin:4px;text-align:center;font:11px sans-serif">'
                    f'<img src="{Path(p).resolve().as_uri()}" style="width:120px;height:120px;object-fit:contain;border:{border}"><br>'
                    f"{html.escape(tag)}</div>"
                )
            status = r["status"] if r["status"] != "ok" else ("no candidate images" if not cells else "")
            rows.append(f"<h3 style='font:14px sans-serif'>{html.escape(name)} <small>{html.escape(status)}</small></h3>{''.join(cells)}<hr>")
        PREVIEW.write_text("<html><body>" + "".join(rows) + "</body></html>", encoding="utf-8")
        print(f"Wrote {PREVIEW} -- open it: green border = would be used as the pill photo.")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for key, r in kept.items():
        src = Path(r["scored"][0][1])
        for label in todo[key]["labels"]:
            if re.match(r"^[A-Za-z0-9._-]+$", label):
                try:  # real JPEG, whatever the label stored (PNG/GIF)
                    Image.open(src).convert("RGB").save(OUT_DIR / f"{label}.jpg", "JPEG", quality=90)
                    written += 1
                except Exception as e:
                    print(f"  skipped unreadable image {src.name}: {e!r}")
                break  # the backend shares it across the pill's listings
    print(f"Wrote {written} label pill photos to {OUT_DIR}. Restart the backend to use them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
