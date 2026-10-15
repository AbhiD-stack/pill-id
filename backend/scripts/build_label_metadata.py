"""Build the two lookup tables the new (pill-scanner-trained) model's serving
code needs: app/data/ndc_names.json and app/data/label_meta.json.

Unlike build_ndc_names.py (the old script, kept for the old checkpoint/table
pairing), this needs NO live network calls -- the pill-scanner acquisition
pipeline already resolved real imprint/color/shape/rx_or_otc data offline
(dailymed_metadata.json), and the training run's own manifest already
recorded each row's category/tier. This script just joins what already
exists; the slow part (RxNav resolution, DailyMed SPL parsing) already
happened on Kaggle.

Inputs (paths are CLI args, since they come from wherever you downloaded the
Kaggle outputs to -- there's no fixed repo-relative location for them):
  --dailymed-metadata   OPTIONAL. dailymed_metadata.json from the
                        dailymed-acquisition-v2 notebook output (NDC ->
                        name/imprint/color/shape/rx_or_otc). Without it,
                        ndc_names.json still gets written but with null
                        name/imprint/color for every label -- the app still
                        works (predictions show the raw label/NDC instead of
                        a friendly drug name), since the accuracy-critical
                        restricted-gallery feature only needs label_meta.json
                        (category/tier), which comes from --manifest alone.
  --checkpoint          best_projection_head.pt from the training run's export/
                        (gives label_classes -- the canonical pooled labels the
                        model actually predicts)
  --manifest            image_manifest.csv from the training run's Kaggle output
                        (gives each label's real category/tier, as computed
                        during that specific run -- more reliable than trying
                        to re-derive "is this a priority drug" ourselves)

Outputs:
  app/data/ndc_names.json   label -> {name, imprint, color, shape, rx_or_otc}
  app/data/label_meta.json  label -> {category, tier}

Run from the backend/ directory:
    python -u scripts/build_label_metadata.py \
        --checkpoint /path/to/best_projection_head.pt \
        --manifest /path/to/image_manifest.csv \
        [--dailymed-metadata /path/to/dailymed_metadata.json]

No torch dependency -- label_classes is read out of the checkpoint's zip/
pickle structure directly with a restricted unpickler that stubs out tensor
reconstruction (we only need the plain-Python metadata dict, not the actual
tensor weights), so this runs anywhere with just the standard library.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import pickle
import re
import zipfile
from collections import Counter
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parents[1] / "app" / "data"


class _Stub:
    """Stands in for any torch class/function the pickle stream references
    (tensor storages, dtypes, the _rebuild_tensor_v2 reducer, etc.) -- we
    never touch the actual tensor data here, only the plain dict/list/str/int
    metadata stored alongside it, which unpickles to real Python objects
    regardless of what the stub returns for everything else."""

    def __init__(self, *args, **kwargs):
        pass

    def __call__(self, *args, **kwargs):
        return _Stub()


class _RestrictedUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module in ("builtins", "collections", "__builtin__"):
            return super().find_class(module, name)
        return _Stub

    def persistent_load(self, pid):
        return _Stub()


def load_label_classes(checkpoint_path: Path) -> list[str]:
    with zipfile.ZipFile(checkpoint_path) as z:
        pkl_names = [n for n in z.namelist() if n.endswith("data.pkl")]
        if not pkl_names:
            raise ValueError(f"No data.pkl found inside {checkpoint_path} -- "
                              f"not a zip-format torch checkpoint?")
        with z.open(pkl_names[0]) as f:
            raw = f.read()
    obj = _RestrictedUnpickler(io.BytesIO(raw)).load()
    return obj["label_classes"]


def normalize_ndc9(ndc: str) -> str:
    """Same normalization as the training pipeline's normalize_ndc9() --
    5-4 digit labeler-product prefix, package size dropped. Must match
    exactly or labels won't line up with dailymed_metadata.json's keys."""
    digits_only = re.sub(r"[^0-9]", "", ndc or "")
    if len(digits_only) < 9:
        return ndc
    return f"{digits_only[:5]}-{digits_only[5:9]}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dailymed-metadata", required=False, type=Path, default=None)
    ap.add_argument("--checkpoint", required=True, type=Path)
    ap.add_argument("--manifest", required=True, type=Path)
    args = ap.parse_args()

    print(f"Loading checkpoint label_classes from {args.checkpoint} ...")
    labels: list[str] = load_label_classes(args.checkpoint)
    print(f"  {len(labels)} canonical labels.")

    dm_by_ndc9: dict[str, dict] = {}
    if args.dailymed_metadata:
        print(f"Loading DailyMed metadata from {args.dailymed_metadata} ...")
        dm_metadata: dict[str, dict] = json.load(open(args.dailymed_metadata))
        # Keyed by raw NDC (any format the acquisition pipeline saw it in) --
        # normalize once into an NDC9 -> entry map for fast, consistent lookup,
        # same as the training pipeline's own pooling logic.
        for ndc, entry in dm_metadata.items():
            dm_by_ndc9.setdefault(normalize_ndc9(ndc), entry)
        print(f"  {len(dm_metadata)} raw entries -> {len(dm_by_ndc9)} distinct NDC9 prefixes.")
    else:
        print("No --dailymed-metadata given -- ndc_names.json will have null "
              "name/imprint/color/shape for every label. label_meta.json "
              "(category/tier, the accuracy-critical part) is unaffected.")

    print(f"Loading manifest from {args.manifest} ...")
    label_tier_cat: dict[str, tuple[str, str]] = {}
    with open(args.manifest, newline="") as f:
        for row in csv.DictReader(f):
            label = row.get("label")
            if not label or label in label_tier_cat:
                continue
            label_tier_cat[label] = (row.get("category", "unknown"), row.get("tier", "unknown"))
    print(f"  category/tier known for {len(label_tier_cat)} distinct labels in this manifest.")

    ndc_names: dict[str, dict] = {}
    label_meta: dict[str, dict] = {}
    matched_metadata = 0
    matched_tier = 0

    for label in labels:
        ndc9 = normalize_ndc9(label)
        dm_entry = dm_by_ndc9.get(ndc9)
        if dm_entry:
            matched_metadata += 1
            ndc_names[label] = {
                "name": dm_entry.get("name"),
                "imprint": dm_entry.get("imprint"),
                "color": dm_entry.get("color"),
                "shape": dm_entry.get("shape"),
                "rx_or_otc": dm_entry.get("rx_or_otc"),
            }
        # else: leave this label absent from ndc_names.json entirely. A dict
        # (even one that's all-None) is truthy, so main.py's
        # `lookup_by_label(label) or lookup(ref_path)` would treat a
        # present-but-empty entry as a hit and never fall through to the
        # older filename-derived lookup, which still has real coverage for
        # some labels. Omitting the key lets `.get(label)` return None and
        # that fallback keep working until real DailyMed metadata exists.

        category, tier = label_tier_cat.get(label, ("unknown", "unknown"))
        if category != "unknown" or tier != "unknown":
            matched_tier += 1
        label_meta[label] = {"category": category, "tier": tier}

    print(f"\n{matched_metadata}/{len(labels)} labels matched real DailyMed metadata "
          f"(name/imprint/color/shape).")
    print(f"{matched_tier}/{len(labels)} labels matched a known category/tier from the manifest.")
    tier_counts = Counter((v["category"], v["tier"]) for v in label_meta.values())
    print(f"By (category, tier): {dict(tier_counts)}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "ndc_names.json").write_text(json.dumps(ndc_names, indent=0, sort_keys=True))
    (OUT_DIR / "label_meta.json").write_text(json.dumps(label_meta, indent=0, sort_keys=True))
    print(f"\nWrote {OUT_DIR / 'ndc_names.json'} ({len(ndc_names)} labels)")
    print(f"Wrote {OUT_DIR / 'label_meta.json'} ({len(label_meta)} labels)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
