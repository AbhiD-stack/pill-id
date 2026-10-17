"""How well does "My Pills" work -- a scan checked against the patient's OWN
saved photos of their own medicines -- on real phone photos?

    cd backend
    .venv\\Scripts\\python.exe scripts\\eval_my_pills.py

Uses ePillID's phone photos (906 pills with 2+ photos). Simulates thousands
of patients: each has N medicines set up (one phone photo of each side
saved, as in the app's setup), then scans ANOTHER phone photo of one of
them. Also scans pills that are NOT theirs ("intruders": a spouse's pill, a
wrong pill in the organizer), and "look-alike" households where two
medicines share color and shape.

Reports: how often the right medicine is first; and, for the app's three
answers -- "This is your X" / "Check the letters on it" / "Not one of your
medicines" -- how often each happens, how often a confident answer is WRONG,
and how many intruders are caught. Then recommends the thresholds the app
should use (paste the last block to Claude).

Caveat: ePillID's phone photos were part of V3's training data, so these
numbers are somewhat optimistic; a check with your own pills matters.
Embeddings are cached in backend/my_pills_embeddings.npz (rerun is fast).
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import random
import sys
import time
import zipfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent / "app"
sys.path.insert(0, str(APP))
os.chdir(APP)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

CACHE = HERE.parent / "my_pills_embeddings.npz"


def embed_all(settings, rows, zf) -> np.ndarray:
    # The cache is only reused if it was made with the same model + adapter.
    made_with = f"{settings.model_artifacts_dir}|{settings.lora_adapter_dir}"
    if CACHE.exists():
        data = np.load(CACHE, allow_pickle=True)
        if list(data["paths"]) == [r["image_path"] for r in rows] and str(data.get("made_with", "")) == made_with:
            print("Using cached embeddings.")
            return data["emb"]
    from classifier import DinoV2PillClassifier
    from config import get_settings

    st = get_settings()
    if st.lora_adapter_dir is None:
        print("WARNING: no LoRA adapter found -- V3 needs it. Expected dinov2_projection_head/lora_adapter "
              "next to the model files, or set LORA_ADAPTER_DIR.")
    print("Loading the model exactly as the server does...")
    clf = DinoV2PillClassifier(model_dir=st.model_artifacts_dir, device=st.device,
                               lora_adapter_dir=st.lora_adapter_dir, label_meta_path=st.label_meta_path)
    out, t0 = [], time.time()
    for i, r in enumerate(rows, 1):
        img = Image.open(io.BytesIO(zf.read("ePillID_data/classification_data/" + r["image_path"]))).convert("RGB")
        out.append(clf.embed_images([img])[0].cpu().numpy())
        if i % 200 == 0 or i == len(rows):
            rate = i / (time.time() - t0)
            print(f"  {i}/{len(rows)} photos embedded ({(len(rows) - i) / rate / 60:.0f} min left)")
    emb = np.stack(out).astype(np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    np.savez(CACHE, emb=emb, paths=np.array([r["image_path"] for r in rows]), made_with=np.array(made_with))
    return emb


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    from config import get_settings
    from drug_names import DrugNameLookup, _color_set, _shape_word

    settings = get_settings()
    if not settings.dataset_zip_path.exists() or settings.dataset_zip_path.stat().st_size < 1_000_000:
        print(f"Need the real ePillID zip at {settings.dataset_zip_path}.")
        return 1
    zf = zipfile.ZipFile(settings.dataset_zip_path)
    allrows = list(csv.DictReader(io.TextIOWrapper(zf.open("ePillID_data/all_labels.csv"), encoding="utf-8")))
    rows = [r for r in allrows if r["is_ref"] == "False"]  # phone photos only
    by_pill: dict[str, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        by_pill[r["pilltype_id"]].append(i)
    pills = [p for p, idx in by_pill.items() if len(idx) >= 2]
    print(f"{len(rows)} phone photos of {len(by_pill)} pills; {len(pills)} have 2+ photos.")
    emb = embed_all(settings, rows, zf)

    # Appearance (FDA color + shape) to build look-alike households.
    names = DrugNameLookup()
    look: dict[str, tuple] = {}
    for p in pills:
        a, b = p.split("-")[:2]
        info = names.lookup_by_label(f"{a.zfill(5)}-{b.zfill(4)}")
        if info and info.get("color") and info.get("shape"):
            look[p] = (_color_set(info["color"]), _shape_word(info["shape"]))
    alike: dict[str, list[str]] = defaultdict(list)
    for p, k in look.items():
        alike[k].append(p)

    rng = random.Random(args.seed)

    def setup(p):
        """Saved photos for pill p (one per side when possible) and the
        photos left over to scan."""
        idx = by_pill[p][:]
        rng.shuffle(idx)
        saved, sides = [], set()
        for i in idx:
            side = rows[i]["is_front"]
            if side not in sides and len(idx) - len(saved) > 1:
                saved.append(i)
                sides.add(side)
        return saved, [i for i in idx if i not in saved]

    def scores(query, household):
        return sorted(((float(np.max(emb[s] @ emb[query])), p) for p, s in household.items()), reverse=True)

    genuine, intruder = [], []  # (best score, margin, best is right)
    for kind in ("normal", "lookalike"):
        for _ in range(args.trials):
            n = rng.choice([5, 8, 12])
            if kind == "lookalike":
                groups = [g for g in alike.values() if len(g) >= 2]
                if not groups:
                    break
                pair = rng.sample(rng.choice(groups), 2)
                meds = pair + rng.sample([p for p in pills if p not in pair], n - 2)
            else:
                meds = rng.sample(pills, n)
            household, left = {}, {}
            for p in meds:
                household[p], left[p] = setup(p)
            target = meds[0]
            q = rng.choice(left[target])
            ranked = scores(q, household)
            margin = ranked[0][0] - (ranked[1][0] if len(ranked) > 1 else -1)
            genuine.append((ranked[0][0], margin, ranked[0][1] == target, kind))
            # someone else's pill, not in this household
            other = rng.choice([p for p in pills if p not in household])
            ranked = scores(rng.choice(by_pill[other]), household)
            intruder.append((ranked[0][0], ranked[0][0] - ranked[1][0], False, kind))

    G = np.array([(s, m, ok) for s, m, ok, _ in genuine], dtype=float)
    I = np.array([(s, m) for s, m, _ok, _ in intruder], dtype=float)
    print("\n=== My Pills on real phone photos ===")
    for kind in ("normal", "lookalike"):
        sel = [ok for _s, _m, ok, k in genuine if k == kind]
        print(f"  Right medicine ranked first ({kind} households): {np.mean(sel):.1%}  ({len(sel)} scans)")

    # Choose thresholds: confident answers ("This is your X") must be wrong
    # at most 0.5% of the time, counting intruders it would wrongly confirm;
    # among those, confirm as many correct scans as possible while still
    # catching 90%+ of intruders as "not yours".
    def search(max_wrong: float, min_caught: float):
        best = None
        for t_reject in np.round(np.arange(0.30, 0.95, 0.01), 2):
            caught = float(np.mean(I[:, 0] < t_reject))
            if caught < min_caught:
                continue
            for t_match in np.round(np.arange(t_reject, 0.99, 0.01), 2):
                for margin in (0.0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.15):
                    conf_g = (G[:, 0] >= t_match) & (G[:, 1] >= margin)
                    conf_i = (I[:, 0] >= t_match) & (I[:, 1] >= margin)
                    wrong = (np.sum(conf_g & (G[:, 2] == 0)) + np.sum(conf_i)) / (len(G) + len(I))
                    if wrong > max_wrong:
                        continue
                    right = float(np.mean(conf_g & (G[:, 2] == 1)))
                    if best is None or right > best[0]:
                        best = (right, t_reject, t_match, margin, caught, wrong)
        return best

    # Strictest bar first; relax only if the model can't meet it.
    for max_wrong, min_caught in ((0.005, 0.90), (0.01, 0.85), (0.02, 0.80), (0.05, 0.70)):
        best = search(max_wrong, min_caught)
        if best:
            print(f"\n  Safety bar met: at most {max_wrong:.1%} wrong confident answers, "
                  f"at least {min_caught:.0%} of other people's pills caught.")
            break
    if best is None:
        print("\nNo setting is safe enough even at 5% wrong confident answers -- the app should not "
              "say \"This is your X\" on its own; paste this to Claude.")
        print(f"  genuine best-score quartiles: {np.percentile(G[:, 0], [25, 50, 75]).round(3)}")
        print(f"  intruder best-score quartiles: {np.percentile(I[:, 0], [25, 50, 75]).round(3)}")
        return 0
    right, t_reject, t_match, margin, caught, wrong = best
    conf = (G[:, 0] >= t_match) & (G[:, 1] >= margin)
    rejected = G[:, 0] < t_reject
    check = ~conf & ~rejected
    print("\n  With the recommended settings, when a patient scans one of THEIR medicines:")
    print(f"    \"This is your X\" and it IS X:            {np.mean(conf & (G[:, 2] == 1)):.1%}")
    print(f"    \"This is your X\" but it's another of theirs: {np.mean(conf & (G[:, 2] == 0)):.2%}")
    print(f"    \"Check the letters on it\" (X or Y?):      {np.mean(check):.1%}"
          f"  (right one listed first: {np.mean(G[check, 2]) if check.any() else 0:.0%})")
    print(f"    \"Not one of your medicines\" (false alarm): {np.mean(rejected):.1%}")
    print("  When someone scans a pill that is NOT one of theirs:")
    print(f"    caught (\"Not one of your medicines\"):     {caught:.1%}")
    print(f"    wrongly confirmed as one of theirs:        {np.mean((I[:, 0] >= t_match) & (I[:, 1] >= margin)):.2%}")
    print("\nRecommended app settings (paste to Claude):")
    print(f"  MY_PILLS_REJECT={t_reject}  MY_PILLS_MATCH={t_match}  MY_PILLS_MARGIN={margin}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
