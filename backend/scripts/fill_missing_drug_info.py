"""Fill in drug info for gallery labels that have none (about a third of
them: name, imprint, color and shape were never looked up, so those pills
showed up in results as bare codes and couldn't be searched or merged).

Uses the free NIH RxNav API -- no key, no cost. Needs internet; run it
LOCALLY (about 20-40 minutes, resumable: rerun to retry anything that was
rate-limited or interrupted). Then restart the backend.

    cd backend
    python scripts/fill_missing_drug_info.py

missing_label_ndcs.json maps each label without info to the NDC to look
up: NDC labels map to themselves; ePillID labels (content hashes) map to
the NDC in their image filenames. "BRAND:..." labels carry their own name.

Self-contained on purpose (standard library only): it runs from any
working directory and doesn't need the app package or PyTorch.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "app" / "data"
TABLE = DATA / "ndc_names.json"
META = DATA / "label_meta.json"
MISSING = HERE / "missing_label_ndcs.json"
CHECKED = DATA / "ndc_names.fill_checked.json"
BASE = os.environ.get("RXNAV_BASE", "https://rxnav.nlm.nih.gov/REST")  # override only for testing


class RateLimited(Exception):
    pass


def _get(url: str) -> dict:
    """GET JSON with retries. Raises RateLimited after repeated failures so
    the NDC is retried on the next run instead of being marked done."""
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=20) as resp:
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
            time.sleep(2 ** attempt)  # 1,2,4,8,16s
    raise RateLimited(url)


def _candidates(ndc: str) -> list[str]:
    """NDC forms to try (most specific product form first)."""
    parts = ndc.split("-")
    cands = []
    if len(parts) >= 2:
        cands.append(f"{parts[0].zfill(5)}-{parts[1].zfill(4)}")
    cands.append(ndc)
    seen: set[str] = set()
    return [c for c in cands if not (c in seen or seen.add(c))]


_name_cache: dict[str, str | None] = {}
_name_lock = threading.Lock()


def _rxnorm_name(rxcui: str) -> str | None:
    with _name_lock:
        if rxcui in _name_cache:
            return _name_cache[rxcui]
    data = _get(f"{BASE}/rxcui/{urllib.parse.quote(rxcui)}/property.json?propName=RxNorm%20Name")
    concepts = (data.get("propConceptGroup") or {}).get("propConcept") or []
    name = concepts[0].get("propValue") if concepts else None
    with _name_lock:
        _name_cache[rxcui] = name
    return name


def resolve(ndc: str) -> tuple[str, dict | None]:
    for cand in _candidates(ndc):
        data = _get(f"{BASE}/ndcproperties.json?id={urllib.parse.quote(cand)}&ndcstatus=ALL")
        props_list = (data.get("ndcPropertyList") or {}).get("ndcProperty") or []
        if not props_list:
            continue
        p = props_list[0]
        props = {
            x.get("propName"): x.get("propValue")
            for x in (p.get("propertyConceptList") or {}).get("propertyConcept") or []
        }
        rxcui = p.get("rxcui") or None
        name = _rxnorm_name(rxcui) if rxcui else None
        if not name:
            continue
        return ndc, {
            "name": name,
            "rxcui": rxcui,
            "imprint": props.get("IMPRINT_CODE") or None,
            "color": props.get("COLORTEXT") or props.get("COLOR") or None,
            "shape": props.get("SHAPETEXT") or None,
            "score_marks": props.get("SCORE") or None,
            "status": props.get("NDC_STATUS") or None,
        }
    return ndc, None


def _save(table: dict, checked: set[str]) -> None:
    # Write to a temp file then replace, so an interruption can't leave a
    # half-written table that the backend then fails to load.
    tmp = TABLE.with_suffix(".tmp")
    tmp.write_text(json.dumps(table, indent=0, sort_keys=True))
    tmp.replace(TABLE)
    CHECKED.write_text(json.dumps(sorted(checked)))


def main() -> int:
    for p in (TABLE, META, MISSING):
        if not p.exists():
            print(f"Missing {p} -- run this from the pill-id repo (git pull first).")
            return 1
    table: dict[str, dict] = json.loads(TABLE.read_text())
    label_to_ndc: dict[str, str] = json.loads(MISSING.read_text())
    checked: set[str] = set(json.loads(CHECKED.read_text())) if CHECKED.exists() else set()

    added = 0
    for label in json.loads(META.read_text()):
        if label.startswith("BRAND:") and label not in table:
            table[label] = {"name": label[len("BRAND:"):].strip()}
            added += 1

    todo = sorted({n for l, n in label_to_ndc.items() if l not in table and n not in checked})
    print(f"{len(label_to_ndc)} labels without info; {len(todo)} NDCs left to look up.")
    if todo:
        print("Checking the connection to RxNav...")
        try:
            _get(f"{BASE}/version.json")
        except RateLimited:
            print("Can't reach rxnav.nlm.nih.gov -- check your internet connection and try again.")
            return 1

    found: dict[str, dict] = {}
    rate_limited = 0

    def apply_found() -> int:
        n = 0
        for label, ndc in label_to_ndc.items():
            if label not in table and ndc in found:
                table[label] = found[ndc]
                n += 1
        return n

    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(resolve, n) for n in todo]
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                ndc, info = fut.result()
                checked.add(ndc)
                if info:
                    found[ndc] = info
            except RateLimited:
                rate_limited += 1
            if i % 250 == 0 or i == len(todo):
                added += apply_found()
                _save(table, checked)  # progress survives an interruption
                print(f"  {i}/{len(todo)} looked up, {len(found)} found so far")

    added += apply_found()
    _save(table, checked)
    still = sum(1 for l in label_to_ndc if l not in table)
    print(f"\nAdded drug info for {added} labels. {still} still have none (RxNav has no record of them).")
    if rate_limited:
        print(f"{rate_limited} lookups failed (rate limit or network) -- run this again to retry them.")
    print("Restart the backend to use it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
