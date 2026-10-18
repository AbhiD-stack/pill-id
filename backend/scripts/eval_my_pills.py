"""How well does "My Pills" work -- a scan checked against the patient's OWN
saved photos of their own medicines -- on real phone photos?

    cd backend
    .venv\\Scripts\\python.exe scripts\\eval_my_pills.py
    .venv\\Scripts\\python.exe scripts\\eval_my_pills.py --photos C:\\my_pill_photos

--photos tests YOUR OWN photos instead (pills the model has never seen):
one folder per pill, 2+ photos each (JPG or PNG; iPhone HEIC photos must be
exported as JPG). Put "back" in the file name for photos of the back side.
Photos don't need cropping; the pill is found automatically.

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


def embed_all(settings, rows, load, cache=CACHE) -> np.ndarray:
    # The cache is only reused if it was made with the same model + adapter.
    made_with = f"{settings.model_artifacts_dir}|{settings.lora_adapter_dir}"
    if cache.exists():
        data = np.load(cache, allow_pickle=True)
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
        out.append(clf.embed_images([load(r)])[0].cpu().numpy())
        if i % 200 == 0 or i == len(rows):
            rate = i / (time.time() - t0)
            print(f"  {i}/{len(rows)} photos embedded ({(len(rows) - i) / rate / 60:.0f} min left)")
    emb = np.stack(out).astype(np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    np.savez(cache, emb=emb, paths=np.array([r["image_path"] for r in rows]), made_with=np.array(made_with))
    return emb


def cohort_all(settings, rows, emb, cache) -> np.ndarray:
    """(n, 2) cohort mean/std of every photo vs the catalog gallery -- the
    same statistic the server returns with each embedding."""
    made_with = f"{settings.model_artifacts_dir}|{settings.lora_adapter_dir}"
    path = cache.with_name(cache.stem + "_cohort.npz")
    if path.exists():
        data = np.load(path, allow_pickle=True)
        if list(data["paths"]) == [r["image_path"] for r in rows] and str(data["made_with"]) == made_with:
            return data["cohort"]
    import torch
    from classifier import DinoV2PillClassifier

    print("Comparing every photo with the catalog (for normalized scores)...")
    clf = DinoV2PillClassifier(model_dir=settings.model_artifacts_dir, device=settings.device,
                               lora_adapter_dir=settings.lora_adapter_dir, label_meta_path=settings.label_meta_path)
    stats = clf.cohort_stats(torch.from_numpy(emb)).numpy()
    np.savez(path, cohort=stats, paths=np.array([r["image_path"] for r in rows]), made_with=np.array(made_with))
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--photos", type=Path, default=None, help="folder with one sub-folder of photos per pill")
    args = ap.parse_args()

    from config import get_settings
    from drug_names import DrugNameLookup, _color_set, _shape_word

    settings = get_settings()
    if args.photos:
        from pill_features import crop_to_pill

        rows, skipped = [], []
        for d in sorted(p for p in args.photos.iterdir() if p.is_dir()):
            for f in sorted(d.iterdir()):
                if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
                    rows.append({"image_path": str(f), "pilltype_id": d.name,
                                 "is_front": "False" if "back" in f.stem.lower() else "True"})
                elif f.is_file():
                    skipped.append(f.name)
        if skipped:
            print(f"Skipped {len(skipped)} files that aren't JPG/PNG (export iPhone HEIC photos as JPG): {skipped[:5]}")
        load = lambda r: crop_to_pill(Image.open(r["image_path"]).convert("RGB"))
        cache = HERE.parent / "my_pills_embeddings_own.npz"
    else:
        if not settings.dataset_zip_path.exists() or settings.dataset_zip_path.stat().st_size < 1_000_000:
            print(f"Need the real ePillID zip at {settings.dataset_zip_path}.")
            return 1
        zf = zipfile.ZipFile(settings.dataset_zip_path)
        allrows = list(csv.DictReader(io.TextIOWrapper(zf.open("ePillID_data/all_labels.csv"), encoding="utf-8")))
        rows = [r for r in allrows if r["is_ref"] == "False"]  # phone photos only
        load = lambda r: Image.open(io.BytesIO(zf.read("ePillID_data/classification_data/" + r["image_path"]))).convert("RGB")
        cache = CACHE
    by_pill: dict[str, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        by_pill[r["pilltype_id"]].append(i)
    pills = [p for p, idx in by_pill.items() if len(idx) >= 2]
    print(f"{len(rows)} phone photos of {len(by_pill)} pills; {len(pills)} have 2+ photos.")
    if len(pills) < 3:
        print("Need at least 3 pills with 2+ photos each.")
        return 1
    emb = embed_all(settings, rows, load, cache)

    # Appearance (FDA color + shape) to build look-alike households.
    names = DrugNameLookup()
    look: dict[str, tuple] = {}
    for p in pills if not args.photos else []:
        a, b = p.split("-")[:2]
        info = names.lookup_by_label(f"{a.zfill(5)}-{b.zfill(4)}")
        if info and info.get("color") and info.get("shape"):
            look[p] = (_color_set(info["color"]), _shape_word(info["shape"]))
    alike: dict[str, list[str]] = defaultdict(list)
    for p, k in look.items():
        alike[k].append(p)

    cohort = cohort_all(settings, rows, emb, cache)
    rng = random.Random(args.seed)

    def setup(p):
        """Saved photos for pill p (one per side, as in the app's setup) and
        the photos left over to scan -- at least 2 when possible, so a scan
        can use both sides too."""
        idx = by_pill[p][:]
        rng.shuffle(idx)
        n_save = 1 if len(idx) <= 3 else 2
        saved, sides = [], set()
        for i in idx:
            if len(saved) < n_save and rows[i]["is_front"] not in sides:
                saved.append(i)
                sides.add(rows[i]["is_front"])
        if not saved:
            saved = idx[:1]
        return saved, [i for i in idx if i not in saved]

    def two(photos):
        """One scan photo, and two (other side first if there is one)."""
        q1 = rng.choice(photos)
        rest = [i for i in photos if i != q1]
        other_side = [i for i in rest if rows[i]["is_front"] != rows[q1]["is_front"]]
        q2 = [q1] + ([rng.choice(other_side or rest)] if rest else [])
        return [q1], q2

    # Every simulated scan: (household, query photos (1), query photos (2), right answer or None)
    trials = []
    for kind in ("normal", "lookalike"):
        for _ in range(args.trials):
            n = min(rng.choice([5, 8, 12]), len(pills) - 1)  # someone else's pill must exist
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
            q1, q2 = two(left[meds[0]])
            trials.append((household, q1, q2, meds[0], kind))
            # Other people's pills: the error that matters most, so 3x the scans
            # (rates near 0.1% need many scans to be trustworthy).
            for other in rng.sample([p for p in pills if p not in household], 3):
                q1, q2 = two(by_pill[other])
                trials.append((household, q1, q2, None, kind))

    E = emb
    MU, SD = cohort[:, 0], cohort[:, 1]

    def score(queries, saved, mode):
        sims = E[saved] @ E[queries].T  # (saved, queries)
        if mode == "snorm":
            sims = 0.5 * ((sims - MU[queries][None, :]) / SD[queries][None, :]
                          + (sims - MU[saved][:, None]) / SD[saved][:, None])
        return float(sims.max(axis=0).mean())

    def run(mode, photos):
        G, I, kinds = [], [], []
        for household, q1, q2, target, kind in trials:
            q = q1 if photos == 1 else q2
            ranked = sorted(((score(q, s, mode), p) for p, s in household.items()), reverse=True)
            margin = ranked[0][0] - ranked[1][0]
            if target is None:
                I.append((ranked[0][0], margin))
            else:
                G.append((ranked[0][0], margin, float(ranked[0][1] == target)))
                kinds.append(kind)
        return np.array(G), np.array(I), kinds

    def search(G, I, bar):
        """Best thresholds meeting a safety bar: (max share of OTHER people's
        pills confirmed as the patient's, max share of the patient's pills
        confirmed as the WRONG one of theirs, max share of the patient's
        pills called "not yours"). Everything in between becomes "check the
        letters". Among settings meeting the bar: most confident-and-right."""
        max_intruder, max_own_wrong, max_false_alarm = bar
        allv = np.concatenate([G[:, 0], I[:, 0]])
        grid = np.unique(np.quantile(allv, np.linspace(0.0, 1.0, 150)))
        margins = np.unique(np.concatenate([[0.0], np.quantile(G[:, 1], [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6])]))
        best = None
        for t_reject in grid:
            false_alarm = float(np.mean(G[:, 0] < t_reject))
            if false_alarm > max_false_alarm:
                break  # grid is increasing: only gets worse
            for t_match in grid[grid >= t_reject]:
                for margin in margins:
                    conf_g = (G[:, 0] >= t_match) & (G[:, 1] >= margin)
                    intruder = float(np.mean((I[:, 0] >= t_match) & (I[:, 1] >= margin)))
                    own_wrong = float(np.mean(conf_g & (G[:, 2] == 0)))
                    if intruder > max_intruder or own_wrong > max_own_wrong:
                        continue
                    right = float(np.mean(conf_g & (G[:, 2] == 1)))
                    caught = float(np.mean(I[:, 0] < t_reject))
                    # Most confident-and-right first; then catch as many other
                    # people's pills as "not yours" as the false-alarm limit allows.
                    if best is None or (right, caught) > (best[0], best[4]):
                        best = (right, float(t_reject), float(t_match), float(margin), caught, intruder)
        return best

    # (others' pills confirmed, own pill confirmed as the wrong one, own pill called "not yours")
    # A setting only counts as useful if at least this share of scans of the
    # patient's own pills get a confident, correct answer (otherwise almost
    # everything would be "check the letters").
    MIN_USEFUL = 0.20
    BARS = ((0.00025, 0.001, 0.01), (0.0005, 0.001, 0.01), (0.001, 0.001, 0.01),
            (0.0025, 0.0025, 0.02), (0.005, 0.005, 0.03), (0.01, 0.01, 0.05))
    print("\n=== My Pills on real phone photos ===")
    results = {}
    for mode in ("raw", "snorm"):
        for photos in (1, 2):
            G, I, kinds = run(mode, photos)
            fallback = None
            for b, bar in enumerate(BARS):
                best = search(G, I, bar)
                if best and best[0] >= MIN_USEFUL:
                    results[(mode, photos)] = (b, best, G, I, kinds)
                    break
                if best and fallback is None:
                    fallback = (b, best, G, I, kinds)
            else:
                if fallback:  # safe, but mostly "check the letters"
                    results[(mode, photos)] = fallback
            name = f"{'plain' if mode == 'raw' else 'normalized'} score, {photos} photo{'s' if photos > 1 else ''}"
            top1 = np.mean(G[:, 2])
            if (mode, photos) in results:
                b, best, *_ = results[(mode, photos)]
                print(f"  {name:32} right first {top1:.1%} | safety level {b + 1} of {len(BARS)} | confident & right {best[0]:.1%}")
            else:
                print(f"  {name:32} right first {top1:.1%} | no safe setting found")
    if not results:
        print("\nNo setting is safe enough -- paste this to Claude.")
        return 0

    # Winner: strictest safety bar met, then most confident-and-right answers.
    (mode, photos), (b, best, G, I, kinds) = min(results.items(), key=lambda kv: (kv[1][0], -kv[1][1][0]))
    right, t_reject, t_match, margin, caught, wrong = best
    print(f"\n  Best: {'normalized' if mode == 'snorm' else 'plain'} score, {photos} photo(s). Safety level {b + 1} of {len(BARS)} met: "
          f"others' pills confirmed <= {BARS[b][0]:.2%}, own pill confirmed as the wrong one <= {BARS[b][1]:.2%}, "
          f"own pill called 'not yours' <= {BARS[b][2]:.0%}.")
    for kind in ("normal", "lookalike"):
        sel = [g[2] for g, k in zip(G, kinds) if k == kind]
        if sel:
            print(f"  Right medicine ranked first ({kind} households): {np.mean(sel):.1%}  ({len(sel)} scans)")
    conf = (G[:, 0] >= t_match) & (G[:, 1] >= margin)
    rejected = G[:, 0] < t_reject
    check = ~conf & ~rejected
    print("\n  When a patient scans one of THEIR medicines:")
    print(f"    \"This is your X\" and it IS X:            {np.mean(conf & (G[:, 2] == 1)):.1%}")
    print(f"    \"This is your X\" but it's another of theirs: {np.mean(conf & (G[:, 2] == 0)):.2%}")
    print(f"    \"Check the letters on it\" (X or Y?):      {np.mean(check):.1%}"
          f"  (right one listed first: {np.mean(G[check, 2]) if check.any() else 0:.0%})")
    print(f"    \"Not one of your medicines\" (false alarm): {np.mean(rejected):.1%}")
    print("  When someone scans a pill that is NOT one of theirs:")
    print(f"    caught (\"Not one of your medicines\"):     {caught:.1%}")
    print(f"    sent to \"check the letters\":                {1 - caught - np.mean((I[:, 0] >= t_match) & (I[:, 1] >= margin)):.1%}")
    print(f"    wrongly confirmed as one of theirs:        {np.mean((I[:, 0] >= t_match) & (I[:, 1] >= margin)):.2%}")
    # The trade-off for the chosen scoring: stricter limits on other people's
    # pills cost confident answers (more "check the letters").
    print("\n  Trade-off (same scoring): limit on other people's pills confirmed -> result")
    for bar in BARS[:3]:
        alt = search(G, I, bar)
        if alt:
            print(f"    <= {bar[0]:.3%}: confident & right {alt[0]:.1%}, others' pills caught as 'not yours' {alt[4]:.1%}, "
                  f"confirmed {alt[5]:.3%}  [REJECT={alt[1]:.4f} MATCH={alt[2]:.4f} MARGIN={alt[3]:.4f}]")
        else:
            print(f"    <= {bar[0]:.3%}: not reachable")
    print("\nRecommended app settings (paste to Claude):")
    print(f"  MY_PILLS_MODE={mode}  MY_PILLS_PHOTOS={photos}  MY_PILLS_REJECT={t_reject:.4f}  "
          f"MY_PILLS_MATCH={t_match:.4f}  MY_PILLS_MARGIN={margin:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
