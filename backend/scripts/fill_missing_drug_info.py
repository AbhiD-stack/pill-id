"""Fill in drug info for gallery labels that have none (about a third of
them: name, imprint, color and shape were never looked up, so those pills
showed up in results as bare codes and couldn't be searched or merged).

Uses the free NIH RxNav API -- no key, no cost. Needs internet; run it
LOCALLY (about 20-40 minutes, resumable: rerun to retry anything that was
rate-limited). Then restart the backend.

    cd backend
    python scripts/fill_missing_drug_info.py

missing_label_ndcs.json maps each label without info to the NDC to look
up: NDC labels map to themselves; ePillID labels (content hashes) map to
the NDC in their image filenames. "BRAND:..." labels carry their own name.
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_ndc_names import OUT, RateLimited, resolve  # noqa: E402

HERE = Path(__file__).resolve().parent
MISSING = HERE / "missing_label_ndcs.json"
META = OUT.parent / "label_meta.json"
CHECKED = OUT.with_name("ndc_names.fill_checked.json")


def main() -> int:
    table: dict[str, dict] = json.loads(OUT.read_text())
    label_to_ndc: dict[str, str] = json.loads(MISSING.read_text())
    checked: set[str] = set(json.loads(CHECKED.read_text())) if CHECKED.exists() else set()

    added = 0
    for label in json.loads(META.read_text()):
        if label.startswith("BRAND:") and label not in table:
            table[label] = {"name": label[len("BRAND:"):].strip()}
            added += 1

    todo_ndcs = sorted({n for l, n in label_to_ndc.items() if l not in table and n not in checked})
    print(f"{len(label_to_ndc)} labels without info; {len(todo_ndcs)} NDCs left to look up")

    found: dict[str, dict] = {}
    rate_limited = 0
    rx_cache: dict[str, str | None] = {}
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(resolve, n, rx_cache) for n in todo_ndcs]
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                ndc, info = fut.result()
                checked.add(ndc)
                if info:
                    found[ndc] = info
            except RateLimited:
                rate_limited += 1
            if i % 250 == 0:
                print(f"  {i}/{len(todo_ndcs)} looked up, {len(found)} found")
                CHECKED.write_text(json.dumps(sorted(checked)))

    for label, ndc in label_to_ndc.items():
        if label not in table and ndc in found:
            table[label] = found[ndc]
            added += 1

    OUT.write_text(json.dumps(table, indent=0, sort_keys=True))
    CHECKED.write_text(json.dumps(sorted(checked)))
    still = sum(1 for l in label_to_ndc if l not in table)
    print(f"\nAdded drug info for {added} labels. {still} still have none (RxNav has no record).")
    if rate_limited:
        print(f"{rate_limited} lookups were rate-limited -- run this again to retry them.")
    print("Restart the backend to use it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
