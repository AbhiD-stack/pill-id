"""Find real pill photos inside each drug's official DailyMed label.

The earlier DailyMed download only took images from the package-label
section, which is almost all box/label art. But many manufacturers also put
a photo of the actual tablet/capsule elsewhere in the label (Description,
How Supplied). This script, for every pill that has no real photo yet:
  1. asks NIH RxNav for the NDC's DailyMed label id (SPL set id),
  2. lists every image in that label (DailyMed API),
  3. skips images whose names say package/carton/structure/etc.,
  4. downloads the rest, and
  5. keeps the first image (most photo-like first) that passes the pixel
     check in app/pill_features.py: one clean pill outline on a plain
     background, little printed detail, and a color AND shape that agree
     with the FDA record for that pill.
(An earlier version asked the recognition model instead; it turned out to
separate image SOURCES -- NIH vs DailyMed -- not pills vs boxes, and kept
only 97 of ~10,600. Rerunning this script redoes those.)
Free, no keys, no model needed. Resumable (downloads are cached). Run LOCALLY:

    cd backend
    python scripts/fetch_label_pill_photos.py --probe 60     # preview + yield
    python scripts/fetch_label_pill_photos.py                # all pills: hours; stop any time,
                                                             # rerun to continue (common drugs first)

--probe writes backend/label_photo_preview.html: open it and check that the
images marked as picked are really pills, and that the score cutoff looks
right. Output: app/data/thumbnails/label_pill/{label}.jpg -- the backend
uses them (after C3PI and ePillID photos) on restart. A full run also
writes backend/label_photo_picks.html: 150 random picks to look over.
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
PICKS = BACKEND / "label_photo_picks.html"
JUDGE_VERSION = 2  # pixel check; results from older judges are redone
sys.path.insert(0, str(BACKEND / "app"))
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


def fetch_candidates(group: dict, look: tuple) -> dict:
    """Runs in worker threads: the label's images that could be a pill
    photo (best rule-based score first), each checked against this pill's
    FDA color/shape; the first that passes is chosen."""
    import pill_features

    setid = spl_set_id(group["ndcs"])
    if not setid:
        return {"status": "no_label", "candidates": [], "chosen": None}
    scored = []
    for m in label_images(setid):
        p = _download(setid, m)
        if p is not None:
            s = score_image(str(p))
            if s > REJECT:  # line art / blank: never a pill photo
                scored.append((s, str(p)))
    scored.sort(reverse=True)
    cands, chosen = [], None
    for s, p in scored[:6]:
        try:
            ok, why = pill_features.judge_pill_photo(Image.open(p), look[0], look[1])
        except Exception as e:  # an unreadable image is just skipped
            ok, why = False, f"unreadable ({e.__class__.__name__})"
        cands.append((s, p, ok, why))
        if ok and chosen is None:
            chosen = p
    return {"status": "ok", "setid": setid, "candidates": cands, "chosen": chosen}


def fda_look(group: dict, names) -> tuple:
    """(FDA color, FDA shape) on record for any listing of this pill."""
    color = shape = None
    for l in list(group["labels"]) + list(group["ndcs"]):
        info = names.lookup_by_label(l) or names._table.get(l)
        if info:
            color = color or info.get("color")
            shape = shape or info.get("shape")
    return color, shape


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", type=int, default=0, help="only N random pills, and write an HTML preview")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    import pill_features
    from drug_names import DrugNameLookup

    if not pill_features.available():
        print("OpenCV is missing, so photos can't be checked. Run this with the backend's Python:")
        print("    .venv\\Scripts\\python.exe scripts\\fetch_label_pill_photos.py")
        return 1
    names = DrugNameLookup()
    todo: dict[str, dict] = json.loads(TODO.read_text())
    # Common (priority) drugs first, so a run stopped early has done the
    # pills people are most likely to scan.
    meta = json.loads((BACKEND / "app" / "data" / "label_meta.json").read_text())
    is_common = lambda g: any(meta.get(l, {}).get("tier") == "priority" for l in g["labels"])
    groups = sorted(todo.items(), key=lambda kv: (not is_common(kv[1]), kv[0]))
    done_path = CACHE / "results.json"
    done: dict[str, dict] = json.loads(done_path.read_text()) if done_path.exists() and not args.probe else {}
    if args.probe:
        random.seed(0)
        groups = random.sample(groups, min(args.probe, len(groups)))
    else:
        # Redo everything an older judge rejected; keep photos already found.
        finished = lambda r: r.get("photo") or r.get("judge") == JUDGE_VERSION or r.get("status") == "no_label"
        groups = [(k, g) for k, g in groups if not (k in done and finished(done[k]))]
    print(f"Looking for pill photos in the DailyMed labels of {len(groups)} pills"
          + (f" ({sum(1 for r in done.values() if r.get('photo'))} found earlier are kept)" if done else "") + "...")
    print("Checking the connection...")
    if _get(f"{RXNAV}/version.json") is None or _get(f"{DAILYMED}/spls.json?pagesize=1") is None:
        print("Can't reach rxnav.nlm.nih.gov / dailymed.nlm.nih.gov -- check your internet connection.")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    rows, found, labels_found, no_record = [], 0, 0, 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {}
        for key, g in groups:
            look = fda_look(g, names)
            no_record += look[0] is None
            futures[pool.submit(fetch_candidates, g, look)] = (key, g, look)
        for i, fut in enumerate(as_completed(futures), 1):
            key, g, look = futures[fut]
            try:
                res = fut.result()
            except Exception as e:  # one bad label shouldn't stop the run
                res = {"status": f"error {e!r}", "candidates": [], "chosen": None}
            labels_found += res["status"] == "ok"
            chosen = res["chosen"]
            if chosen and not args.probe:
                label = next((l for l in g["labels"] if re.match(r"^[A-Za-z0-9._-]+$", l)), None)
                try:  # real JPEG, whatever the label stored; written now so stopping early keeps it
                    if label is None:
                        raise ValueError("no usable file name")
                    Image.open(chosen).convert("RGB").save(OUT_DIR / f"{label}.jpg", "JPEG", quality=90)
                except Exception as e:
                    print(f"  skipped {Path(chosen).name}: {e!r}")
                    chosen = None
            found += bool(chosen)
            rows.append((g, look, res["candidates"], chosen))
            if not args.probe:
                done[key] = {"status": res["status"], "photo": bool(chosen), "judge": JUDGE_VERSION,
                             "setid": res.get("setid")}
                if i % 50 == 0:
                    done_path.write_text(json.dumps(done))
            if i % 100 == 0 or i == len(groups):
                print(f"  {i}/{len(groups)} pills checked, {found} pill photos found")
    if not args.probe:
        done_path.write_text(json.dumps(done))

    total = sum(1 for r in done.values() if r.get("photo")) if not args.probe else found
    print(f"\nDailyMed label found for {labels_found}/{len(groups)} pills; {found} new pill photos"
          + (f" ({total} in total)" if not args.probe else "") + ".")
    if no_record:
        print(f"({no_record} pills have no FDA color on record, so a photo can't be checked and none is used.)")

    picked = [r for r in rows if r[3]]
    random.seed(1)
    sample = rows if args.probe else random.sample(picked, min(150, len(picked)))
    out = PREVIEW if args.probe else PICKS
    _write_preview(out, sorted(sample, key=lambda r: not r[3]))
    print(f"Wrote {out} -- open it and check that the pictures with a green border are pills.")
    if not args.probe:
        print(f"Pill photos are in {OUT_DIR}. Next: python scripts/build_photo_gallery.py, then restart the backend.")
    return 0


def _write_preview(path: Path, rows) -> None:
    parts = []
    for g, look, cands, chosen in rows:
        cells = []
        for s, p, ok, why in cands:
            border = "4px solid #16a34a" if p == chosen else "1px solid #ccc"
            cells.append(
                f'<div style="display:inline-block;margin:4px;text-align:center;font:11px sans-serif;width:140px;vertical-align:top">'
                f'<img src="{Path(p).resolve().as_uri()}" style="width:130px;height:130px;object-fit:contain;border:{border}"><br>'
                f"{html.escape(why)}</div>"
            )
        parts.append(f"<h3 style='font:14px sans-serif'>{html.escape(g['labels'][0])} "
                     f"<span style='color:#666'>(FDA: {html.escape(str(look[0]))}, {html.escape(str(look[1]))})</span></h3>"
                     + ("".join(cells) or "<p style='font:12px sans-serif'>no candidate images</p>") + "<hr>")
    path.write_text("<html><body>" + "".join(parts) + "</body></html>", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
