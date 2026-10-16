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
    python scripts/fetch_label_pill_photos.py --probe 60     # preview + yield
    python scripts/fetch_label_pill_photos.py                # all pills: hours; stop any time,
                                                             # rerun to continue (common drugs first)

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


def fetch_candidates(group: dict) -> dict:
    """Network part (runs in worker threads): the label's images that could
    be a pill photo, best rule-based score first."""
    setid = spl_set_id(group["ndcs"])
    if not setid:
        return {"status": "no_label", "candidates": []}
    scored = []
    for m in label_images(setid):
        p = _download(setid, m)
        if p is not None:
            s = score_image(str(p))
            if s > REJECT:  # line art / blank: never a pill photo
                scored.append((s, str(p)))
    scored.sort(reverse=True)
    return {"status": "ok", "setid": setid, "candidates": scored[:6]}


class PhotoJudge:
    """Recognizes real pill photos with the pill model itself: an image whose
    nearest gallery neighbors are mostly real pill photos (ePillID / C3PI)
    rather than DailyMed package art is a pill photo. On the real gallery
    this catches 99.7% of pill photos while flagging <1% of package images
    (the rule-based scorer misses multi-pill shots, colored backgrounds,
    etc.). Loads the model exactly like the server."""

    K = 15
    THRESHOLD = 0.5

    def __init__(self):
        import torch

        app = BACKEND / "app"
        sys.path.insert(0, str(app))
        os.chdir(app)  # same .env/settings as `uvicorn main:app`
        default_lora = BACKEND.parent / "dinov2_projection_head" / "lora_adapter"
        if not os.environ.get("LORA_ADAPTER_DIR") and default_lora.is_dir():
            os.environ["LORA_ADAPTER_DIR"] = str(default_lora)
        from classifier import DinoV2PillClassifier
        from config import get_settings

        st = get_settings()
        self.torch = torch
        self.clf = DinoV2PillClassifier(model_dir=st.model_artifacts_dir, device=st.device,
                                        lora_adapter_dir=st.lora_adapter_dir, label_meta_path=st.label_meta_path)
        dev = self.clf.ref_embeddings.device
        self.photo = torch.tensor(
            ["ePillID_data" in str(p) or "notebook6b49fb1258" in str(p) or "rximage" in str(p) for p in self.clf.ref_abs_paths],
            device=dev,
        )
        self.index = {str(l): i for i, l in enumerate(self.clf.label_strings)}

    def photo_fractions(self, paths: list[str], own_labels: list[str]) -> list[float]:
        torch = self.torch
        images = [Image.open(p).convert("RGB") for p in paths]
        with torch.no_grad():
            sims = self.clf.embed_images(images) @ self.clf.ref_embeddings.T
            own = [self.index[l] for l in own_labels if l in self.index]
            if own:  # the pill's own gallery images don't count as neighbors
                sims[:, torch.isin(self.clf.ref_label_indices, torch.tensor(own, device=sims.device))] = -9
            top = sims.topk(self.K, dim=1).indices
            return self.photo[top].float().mean(1).tolist()


def pick(cands: list[tuple[float, str]], fracs: list[float] | None, min_score: float):
    """(path, photo_fraction or None) of the image to use, or None."""
    if fracs is None:
        return (cands[0][1], None) if cands and cands[0][0] >= min_score else None
    ok = [(f, s, p) for (s, p), f in zip(cands, fracs) if f >= PhotoJudge.THRESHOLD]
    if not ok:
        return None
    f, s, p = max(ok)
    return p, f


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", type=int, default=0, help="only N random pills, and write an HTML preview")
    ap.add_argument("--min-score", type=float, default=1.0, help="rule-based cutoff, used only with --no-model")
    ap.add_argument("--no-model", action="store_true", help="judge photos with the rule-based scorer only (no model)")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

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
        groups = [(k, g) for k, g in groups if k not in done]
    print(f"Looking for pill photos in the DailyMed labels of {len(groups)} pills"
          + (f" ({len(done)} already done earlier)" if done else "") + "...")
    print("Checking the connection...")
    if _get(f"{RXNAV}/version.json") is None or _get(f"{DAILYMED}/spls.json?pagesize=1") is None:
        print("Can't reach rxnav.nlm.nih.gov / dailymed.nlm.nih.gov -- check your internet connection.")
        return 1

    judge = None
    if not args.no_model:
        print("Loading the pill model to recognize pill photos (stop the backend first if it's running)...")
        try:
            judge = PhotoJudge()
        except Exception as e:
            print(f"Couldn't load the model ({e!r}); using the rule-based scorer instead.")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    preview_rows, found, labels_found = [], 0, 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch_candidates, g): (key, g) for key, g in groups}
        for i, fut in enumerate(as_completed(futures), 1):
            key, g = futures[fut]
            try:
                res = fut.result()
            except Exception as e:  # one bad label shouldn't stop the run
                res = {"status": f"error {e!r}", "candidates": []}
            cands = res["candidates"]
            labels_found += res["status"] == "ok"
            fracs = None
            if judge is not None and cands:
                try:
                    fracs = judge.photo_fractions([p for _, p in cands], g["labels"])
                except Exception as e:
                    print(f"  model check failed for {g['labels'][0]}: {e!r}")
            chosen = pick(cands, fracs, args.min_score) if (judge is None or fracs is not None) else None
            if args.probe:
                preview_rows.append((g, cands, fracs, chosen))
            elif chosen:
                label = next((l for l in g["labels"] if re.match(r"^[A-Za-z0-9._-]+$", l)), None)
                if label:
                    try:  # real JPEG, whatever the label stored; written now so stopping early keeps it
                        Image.open(chosen[0]).convert("RGB").save(OUT_DIR / f"{label}.jpg", "JPEG", quality=90)
                    except Exception as e:
                        print(f"  skipped unreadable image {Path(chosen[0]).name}: {e!r}")
                        chosen = None
            found += bool(chosen)
            if not args.probe:
                done[key] = {"status": res["status"], "photo": bool(chosen)}
                if i % 50 == 0:
                    done_path.write_text(json.dumps(done))
            if i % 100 == 0 or i == len(groups):
                print(f"  {i}/{len(groups)} pills checked, {found} pill photos found")
    if not args.probe:
        done_path.write_text(json.dumps(done))

    how = "the model" if judge else f"the rule-based score >= {args.min_score}"
    print(f"\nDailyMed label found for {labels_found}/{len(groups)} pills; {found} have a pill photo (judged by {how}).")

    if args.probe:
        rows = []
        for g, cands, fracs, chosen in sorted(preview_rows, key=lambda r: not r[3]):
            cells = []
            for j, (s, p) in enumerate(cands):
                picked = bool(chosen) and chosen[0] == p
                border = "4px solid #16a34a" if picked else "1px solid #ccc"
                tag = f"score {s:.2f}" + (f" · model {fracs[j]:.0%} photo" if fracs else "")
                cells.append(
                    f'<div style="display:inline-block;margin:4px;text-align:center;font:11px sans-serif">'
                    f'<img src="{Path(p).resolve().as_uri()}" style="width:130px;height:130px;object-fit:contain;border:{border}"><br>'
                    f"{html.escape(tag)}</div>"
                )
            rows.append(f"<h3 style='font:14px sans-serif'>{html.escape(g['labels'][0])}</h3>"
                        + ("".join(cells) or "<p style='font:12px sans-serif'>no candidate images</p>") + "<hr>")
        PREVIEW.write_text("<html><body>" + "".join(rows) + "</body></html>", encoding="utf-8")
        print(f"Wrote {PREVIEW} -- open it: green border = will be used as the pill photo.")
        return 0
    print(f"Pill photos are in {OUT_DIR}. Restart the backend to use them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
