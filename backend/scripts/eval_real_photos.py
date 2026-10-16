"""Measure real-world accuracy: run the app's own identification pipeline
(main.identify -- exactly what /api/predict does) on real consumer photos of
pills from the ePillID dataset, with known answers.

    cd backend
    python scripts/eval_real_photos.py                  # 200 photos, ~10-20 min on CPU
    python scripts/eval_real_photos.py --n 500
    python scripts/eval_real_photos.py --mode package-only

Uses the same model files and settings as the server (set LORA_ADAPTER_DIR
etc. in the same window first), and the ePillID zip the server already uses
for thumbnails.

Fairness: ePillID's consumer photos were added to the gallery, so a naive
test would find each photo itself. Every consumer photo is removed from the
gallery first; the pills keep their studio reference photos.

--mode package-only additionally removes every real pill photo (ePillID and
C3PI) from the gallery, leaving only DailyMed package/label images -- the
situation for most drugs, where there is no reference photo of the pill.

For each photo, three conditions:
  A  photo only (user says there's no imprint)
  B  photo + the imprint the app's OCR reads, accepted unchanged
  C  photo + the correct imprint, as if the user typed it
A result counts as correct if it is the same physical pill (any listing).
Per-photo results are written to backend/eval_results.csv.
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import random
import re
import sys
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent / "app"
sys.path.insert(0, str(APP))
os.chdir(APP)  # same working directory (and .env) as `uvicorn main:app` from backend/app

import torch  # noqa: E402
from PIL import Image  # noqa: E402

import main  # noqa: E402
from classifier import DinoV2PillClassifier  # noqa: E402
from config import get_settings  # noqa: E402
from drug_names import DrugNameLookup, _imprint_tokens, ndc_from_ref_path, pill_key  # noqa: E402
from imprint_match import ocr_engine, read_imprint_text  # noqa: E402

_NDC = re.compile(r"^(\d{4,5})-(\d{3,4})")


def ndc9(token: str) -> str | None:
    m = _NDC.match(token or "")
    return f"{m.group(1).zfill(5)}-{m.group(2).zfill(4)}" if m else None


def load_classifier(settings) -> DinoV2PillClassifier:
    return DinoV2PillClassifier(
        model_dir=settings.model_artifacts_dir,
        device=settings.device,
        lora_adapter_dir=settings.lora_adapter_dir,
        label_meta_path=settings.label_meta_path,
    )


def restrict_gallery(clf, drop) -> int:
    """Remove gallery images whose path matches drop(path)."""
    keep = torch.tensor([not drop(str(p)) for p in clf.ref_abs_paths], device=clf.ref_embeddings.device)
    clf.ref_embeddings = clf.ref_embeddings[keep]
    clf.ref_label_indices = clf.ref_label_indices[keep]
    clf.ref_abs_paths = clf.ref_abs_paths[keep.cpu().numpy()]
    return int((~keep).sum())


def build_truth(clf, names: DrugNameLookup):
    """ndc9 -> gallery labels for it (via label or image filename), and
    ndc9 -> physical-pill keys of every listing of it."""
    labels_by_ndc: dict[str, set[str]] = {}
    label_idx = clf.ref_label_indices.cpu().tolist()
    for path, li in zip(clf.ref_abs_paths, label_idx):
        n = ndc9(ndc_from_ref_path(str(path)))
        if n:
            labels_by_ndc.setdefault(n, set()).add(str(clf.label_strings[li]))
    for lbl in clf.label_strings:
        n = ndc9(str(lbl))
        if n:
            labels_by_ndc.setdefault(n, set()).add(str(lbl))
    keys_by_ndc: dict[str, set[tuple]] = {}
    for lbl, info in names._table.items():
        n = ndc9(lbl)
        if n:
            keys_by_ndc.setdefault(n, set()).add(pill_key(lbl, info))
    for n, lbls in labels_by_ndc.items():
        for lbl in lbls:
            info = names.lookup_by_label(lbl)
            if info:
                keys_by_ndc.setdefault(n, set()).add(pill_key(lbl, info))
    return labels_by_ndc, keys_by_ndc


def truth_imprint(n: str, names: DrugNameLookup, labels: set[str]) -> str | None:
    for lbl in sorted(labels) + [n]:
        info = names.lookup_by_label(lbl)
        if info and info.get("imprint"):
            return " ".join(_imprint_tokens(info["imprint"]))
    return None


def rank_of_truth(ident, names: DrugNameLookup, truth_labels: set[str], truth_keys: set[tuple]) -> int | None:
    truth_groups = {names.dedupe_key(l, None) for l in truth_labels}
    for i, (p, info, _m, _s) in enumerate(ident.ranked, 1):
        if (p.label in truth_labels or names.dedupe_key(p.label, info) in truth_groups
                or (info and pill_key(p.label, info) in truth_keys)):
            return i
    return None


def main_() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--mode", choices=["strict", "package-only"], default="strict")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-ocr", action="store_true", help="skip condition B (OCR is the slow part)")
    args = ap.parse_args()

    settings = get_settings()
    if not settings.dataset_zip_path.exists() or settings.dataset_zip_path.stat().st_size < 1_000_000:
        print(f"Need the real ePillID zip at {settings.dataset_zip_path} (run `git lfs pull` if it's a small pointer file).")
        return 1
    zf = zipfile.ZipFile(settings.dataset_zip_path)
    rows = list(csv.DictReader(io.TextIOWrapper(zf.open("ePillID_data/all_labels.csv"), encoding="utf-8")))
    consumer = [r for r in rows if r["is_ref"] == "False"]

    print("Loading the model exactly as the server does...")
    clf = load_classifier(settings)
    names = DrugNameLookup()
    main.attach_pill_groups(clf, names)  # same duplicate merging as the server
    main._check_artifacts(clf, names, settings)

    dropped = restrict_gallery(clf, lambda p: "/dc_224/" in p)
    if args.mode == "package-only":
        dropped += restrict_gallery(clf, lambda p: "ePillID_data" in p or "notebook6b49fb1258" in p or "rximage" in p)
    print(f"Removed {dropped} gallery images for a fair test ({args.mode}); {clf.ref_embeddings.shape[0]} remain.")

    labels_by_ndc, keys_by_ndc = build_truth(clf, names)
    usable = []
    for r in consumer:
        n = ndc9(r["pilltype_id"])
        if n and (labels_by_ndc.get(n) or keys_by_ndc.get(n)):
            usable.append(r)
    random.Random(args.seed).shuffle(usable)
    sample = usable[: args.n]
    print(f"{len(consumer)} consumer photos; {len(usable)} are of a pill still findable in this gallery; testing {len(sample)}.")
    print(f"OCR engine for condition B: {ocr_engine()}\n")

    conds = ["A photo only", "B photo + OCR read, unchecked", "C photo + correct imprint"]
    stats = {c: [0, 0, 0] for c in conds}  # top1, top5, n
    out_rows = []
    t0 = time.time()
    for i, r in enumerate(sample, 1):
        n = ndc9(r["pilltype_id"])
        truth_labels = labels_by_ndc.get(n, set())
        truth_keys = keys_by_ndc.get(n, set())
        img = Image.open(io.BytesIO(zf.read("ePillID_data/classification_data/" + r["image_path"]))).convert("RGB")
        embs = clf.embed_images([img])
        real_imprint = truth_imprint(n, names, truth_labels)
        ocr = None if args.no_ocr else read_imprint_text(img, names.imprint_vocab)
        inputs = {
            conds[0]: "",
            conds[1]: None if args.no_ocr else (ocr or ""),
            conds[2]: real_imprint,
        }
        rec = {"image": r["image_path"], "ndc": n, "true_imprint": real_imprint or "", "ocr_read": ocr or ""}
        for c, imprint in inputs.items():
            if imprint is None:  # condition not applicable to this photo
                rec[c] = ""
                continue
            ident = main.identify(clf, names, [img], imprint=imprint, imprint_confirmed=True, query_embs=embs)
            rank = rank_of_truth(ident, names, truth_labels, truth_keys)
            s = stats[c]
            s[2] += 1
            s[0] += rank == 1
            s[1] += rank is not None and rank <= 5
            rec[c] = rank or ""
        out_rows.append(rec)
        if i % 25 == 0 or i == len(sample):
            el = time.time() - t0
            print(f"  {i}/{len(sample)} photos ({el / i:.1f}s each)")

    print(f"\nReal-world accuracy ({args.mode} gallery), same physical pill counted as correct:")
    for c in conds:
        top1, top5, k = stats[c]
        if k:
            print(f"  {c:28} top-1 {top1 / k:6.1%}   top-5 {top5 / k:6.1%}   ({k} photos)")
        else:
            print(f"  {c:28} not measured")
    out = HERE.parent / "eval_results.csv"
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()) if out_rows else ["image"])
        w.writeheader()
        w.writerows(out_rows)
    print(f"\nPer-photo results: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main_())
