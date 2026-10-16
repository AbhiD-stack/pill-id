"""Add the real pill photos found in drug labels to the model's reference
gallery -- no retraining.

Most of the gallery's DailyMed images are package art, so a phone photo of
a pill whose only references are boxes is compared against boxes. This
embeds every photo fetch_label_pill_photos.py found
(app/data/thumbnails/label_pill/{label}.jpg) with the same model and saves
them to app/data/photo_gallery.pt; the backend adds them to the gallery at
startup.

A label's photo can show a different strength of the same drug (one label
covers several), so each photo is checked first: its color, read from the
pixels, must agree with the FDA color on record for that pill. Photos that
disagree are left out (listed in photo_gallery_rejected.txt).

Run LOCALLY with the backend stopped (it loads the model):

    cd backend
    python scripts/build_photo_gallery.py

Rerun after fetching more photos: already-embedded photos are reused.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
APP = BACKEND / "app"
sys.path.insert(0, str(APP))
os.chdir(APP)  # same .env/settings as `uvicorn main:app`

PHOTO_DIRS = ("label_pill",)
REJECTED = BACKEND / "photo_gallery_rejected.txt"


def main() -> int:
    default_lora = BACKEND.parent / "dinov2_projection_head" / "lora_adapter"
    if not os.environ.get("LORA_ADAPTER_DIR") and default_lora.is_dir():
        os.environ["LORA_ADAPTER_DIR"] = str(default_lora)

    import torch
    from PIL import Image

    import pill_features
    from classifier import DinoV2PillClassifier
    from config import get_settings
    from drug_names import DrugNameLookup
    from main import attach_pill_groups, model_signature

    st = get_settings()
    files = [f for d in PHOTO_DIRS if (st.thumbnails_dir / d).is_dir() for f in sorted((st.thumbnails_dir / d).glob("*.jpg"))]
    if not files:
        print(f"No photos in {st.thumbnails_dir / 'label_pill'} -- run scripts/fetch_label_pill_photos.py first.")
        return 1
    if not pill_features.available():
        print("OpenCV is missing (it comes with easyocr): pip install easyocr")
        return 1

    print("Loading the model (stop the backend first if it's running)...")
    clf = DinoV2PillClassifier(model_dir=st.model_artifacts_dir, device=st.device,
                               lora_adapter_dir=st.lora_adapter_dir, label_meta_path=st.label_meta_path)
    if st.lora_adapter_dir is None or not Path(st.lora_adapter_dir).exists():
        print("WARNING: no LoRA adapter found -- these embeddings won't match the V3 gallery. "
              "Set LORA_ADAPTER_DIR (same as for the backend) and rerun.")
        return 1
    names = DrugNameLookup()
    attach_pill_groups(clf, names)  # lends color data across listings of the same pill
    known = {str(l) for l in clf.label_strings}
    sig = model_signature(clf)

    old = {}
    if st.photo_gallery_path.exists():
        prev = torch.load(st.photo_gallery_path, map_location="cpu")
        if prev.get("model_signature") == sig:
            for i, key in enumerate(prev.get("keys", [])):
                old[key] = (prev["embeddings"][i], prev["labels"][i], prev["paths"][i])

    embs, labels, paths, keys, rejected = [], [], [], [], []
    counts = {"reused": 0, "added": 0, "no_label": 0, "color_mismatch": 0, "unreadable": 0}
    t0 = time.time()
    for n, f in enumerate(files, 1):
        label = f.stem
        key = f"{f.parent.name}/{f.name}:{f.stat().st_size}:{int(f.stat().st_mtime)}"
        if key in old:
            e, l, p = old[key]
            embs.append(e), labels.append(l), paths.append(p), keys.append(key)
            counts["reused"] += 1
            continue
        if label not in known:
            counts["no_label"] += 1
            continue
        try:
            img = Image.open(f).convert("RGB")
        except Exception:
            counts["unreadable"] += 1
            continue
        info = names.display_info(label)
        verdict = pill_features.photo_matches_record(img, info.get("color") if info else None)
        if verdict is False:
            counts["color_mismatch"] += 1
            rejected.append(f"{f.name}\tFDA color: {info.get('color')}")
            continue
        with torch.no_grad():
            e = clf.embed_images([img])[0].cpu().half()
        # Name the path after a reference of the same label, so code that reads
        # an NDC out of a gallery path keeps working.
        embs.append(e), labels.append(label), keys.append(key)
        paths.append(f"extra_photo/{f.parent.name}/{_path_prefix(clf, label)}_{f.name}")
        counts["added"] += 1
        if n % 100 == 0:
            rate = n / max(time.time() - t0, 1e-6)
            print(f"  {n}/{len(files)} photos ({rate:.1f}/s, about {(len(files) - n) / rate / 60:.0f} min left)")

    if not embs:
        print("No usable photos.", counts)
        return 1
    tmp = st.photo_gallery_path.with_suffix(".tmp")
    torch.save({"model_signature": sig, "embeddings": torch.stack(embs), "labels": labels, "paths": paths, "keys": keys}, tmp)
    os.replace(tmp, st.photo_gallery_path)
    REJECTED.write_text("\n".join(rejected), encoding="utf-8")
    print(f"\nDone: {len(embs)} pill photos in {st.photo_gallery_path.name} "
          f"({counts['added']} new, {counts['reused']} from before).")
    print(f"Left out: {counts['color_mismatch']} whose color disagrees with the FDA record "
          f"(see {REJECTED.name}), {counts['no_label']} for pills not in the model, "
          f"{counts['unreadable']} unreadable.")
    print("Restart the backend to use them.")
    return 0


def _path_prefix(clf, label: str) -> str:
    import numpy as np
    from drug_names import ndc_from_ref_path

    idx = int(np.where(clf.label_strings == label)[0][0])
    for p in clf.ref_abs_paths[(clf.ref_label_indices == idx).cpu().numpy()]:
        return ndc_from_ref_path(str(p))
    return label


if __name__ == "__main__":
    sys.exit(main())
