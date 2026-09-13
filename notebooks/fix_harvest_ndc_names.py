"""Fix broken drug names in the DailyMed harvest checkpoint via RxNav lookup.

Bug this fixes: V3.B3's SPL-XML name extraction grabbed ALL <name> elements
anywhere in the document (labeler organization name, active ingredient name,
every inactive ingredient/excipient name, ...) and assigned them by raw
document position (names[0]=brand, names[1]=generic, names[-1]=labeler).
That assumption doesn't hold against DailyMed's real SPL structure: a check
of the actual harvest_checkpoint.json showed 887/1,119 (79%) of entries have
a manufacturer/packager name (e.g. "American Health Packaging") sitting in
brand_name/generic_name, and 252/1,119 (23%) have a random inactive
excipient (e.g. "Sucrose", "Triacetin") in the labeler_name slot instead of
the actual drug -- neither field is reliably "the drug name". If this had
shipped, the app would have told a user their pill was called "American
Health Packaging".

The good news: NDC extraction used a completely different, targeted method
(matching the NDC OID directly in the XML) and is unaffected -- 1,119/1,119
NDCs in the checkpoint are correctly formatted. So this doesn't need any
re-harvesting or re-parsing of the (already-deleted) source SPL zips at
all -- it just needs to resolve each already-correct NDC to its real name
via NIH's RxNav API, exactly the same proven method backend/scripts/
build_ndc_names.py already uses for the original ePillID/OTC name table.

No GPU needed. Run this anywhere with internet access -- a plain Colab CPU
runtime, or locally on your own machine with Python 3 (needs no packages
beyond the standard library).

Usage:
    python fix_harvest_ndc_names.py \
        --checkpoint /path/to/harvest_checkpoint.json \
        --existing-ndc-names /path/to/backend/app/data/ndc_names.json \
        --out /path/to/corrected_ndc_names.json

Or in Colab, after mounting Drive:
    !python fix_harvest_ndc_names.py \
        --checkpoint "/content/drive/MyDrive/.../harvest_checkpoint.json" \
        --existing-ndc-names "/content/drive/MyDrive/.../ndc_names.json" \
        --out "/content/drive/MyDrive/.../corrected_ndc_names.json"

Resumable: rerun with the same --out path to pick up where a rate-limited
or interrupted run left off (checkpoints resolved/checked NDCs to a
sibling *.checked.json file, same convention as build_ndc_names.py).
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE = "https://rxnav.nlm.nih.gov/REST"


class RateLimited(Exception):
    pass


def _get(url: str, timeout: int = 20, retries: int = 5) -> dict:
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pill-id-research/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except Exception as e:
            last_err = e
            time.sleep(2 ** attempt)  # 1,2,4,8,16s
    raise RateLimited(f"{url}: {last_err}")


def _candidates(token: str) -> list[str]:
    """NDC id forms to try against ndcproperties (most specific first)."""
    parts = token.split("-")
    cands: list[str] = []
    if len(parts) >= 2:
        cands.append(f"{parts[0].zfill(5)}-{parts[1].zfill(4)}")  # ndc9
    cands.append(token)
    seen: set[str] = set()
    return [c for c in cands if not (c in seen or seen.add(c))]


def _rxname(rxcui: str, cache: dict[str, str | None]) -> str | None:
    if rxcui in cache:
        return cache[rxcui]
    data = _get(f"{BASE}/rxcui/{rxcui}/property.json?propName=RxNorm%20Name")
    pc = data.get("propConceptGroup", {}).get("propConcept", [])
    name = pc[0]["propValue"] if pc else None
    cache[rxcui] = name
    return name


def _find_prop_containing(props: dict[str, str], *substrings: str) -> str | None:
    for prop_name, value in props.items():
        upper = prop_name.upper()
        if any(s in upper for s in substrings) and value:
            return value
    return None


def resolve(token: str, rx_cache: dict[str, str | None]) -> tuple[str, dict | None]:
    for cand in _candidates(token):
        data = _get(f"{BASE}/ndcproperties.json?id={cand}&ndcstatus=ALL")
        pl = data.get("ndcPropertyList", {}).get("ndcProperty", [])
        if not pl:
            continue
        p = pl[0]
        props = {
            x["propName"]: x["propValue"]
            for x in p.get("propertyConceptList", {}).get("propertyConcept", [])
        }
        rxcui = p.get("rxcui") or None
        name = _rxname(rxcui, rx_cache) if rxcui else None
        if not name:
            continue
        return token, {
            "name": name,
            "rxcui": rxcui,
            "imprint": props.get("IMPRINT_CODE") or None,
            "color": props.get("COLORTEXT") or None,
            "status": props.get("NDC_STATUS") or None,
            "shape": _find_prop_containing(props, "SHAPE"),
            "score": _find_prop_containing(props, "SCORE"),
        }
    return token, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True, help="Path to harvest_checkpoint.json")
    ap.add_argument("--existing-ndc-names", default=None,
                     help="Path to the current backend/app/data/ndc_names.json to merge into (optional)")
    ap.add_argument("--out", required=True, help="Where to write the corrected merged ndc_names.json")
    ap.add_argument("--workers", type=int, default=5)
    args = ap.parse_args()

    checkpoint = json.load(open(args.checkpoint))
    qualifying_products = checkpoint["qualifying_products"]
    tokens = sorted({p["ndc"] for p in qualifying_products if p.get("ndc")})
    print(f"{len(tokens)} unique NDCs to resolve from the harvest checkpoint "
          f"({len(qualifying_products)} qualifying products total)")

    out_path = Path(args.out)
    checked_path = out_path.with_suffix(".checked.json")

    table: dict[str, dict] = {}
    if args.existing_ndc_names and Path(args.existing_ndc_names).exists():
        table = json.load(open(args.existing_ndc_names))
        print(f"Loaded {len(table)} existing entries from {args.existing_ndc_names}")
    if out_path.exists():
        # A previous run of THIS script already wrote some corrected entries -- resume from there.
        table.update(json.load(open(out_path)))

    checked: set[str] = set(json.load(open(checked_path))) if checked_path.exists() else set()
    todo = [t for t in tokens if t not in table and t not in checked]
    print(f"{len(table)} already named, {len(todo)} to fetch")

    rx_cache: dict[str, str | None] = {}
    resolved = rate_limited = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(resolve, t, rx_cache): t for t in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            token = futures[fut]
            try:
                token, info = fut.result()
                checked.add(token)
                if info:
                    table[token] = info
                    resolved += 1
            except RateLimited:
                rate_limited += 1
            if i % 100 == 0:
                print(f"  {i}/{len(todo)} processed, {resolved} resolved, {rate_limited} rate-limited")
                out_path.parent.mkdir(parents=True, exist_ok=True)
                json.dump(table, open(out_path, "w"), indent=0, sort_keys=True)
                json.dump(sorted(checked), open(checked_path, "w"))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    json.dump(table, open(out_path, "w"), indent=0, sort_keys=True)
    json.dump(sorted(checked), open(checked_path, "w"))
    print(f"Wrote {len(table)} total NDC names -> {out_path}")
    unresolved = len(tokens) - sum(1 for t in tokens if t in table)
    if unresolved:
        print(f"{unresolved}/{len(tokens)} harvest NDCs could not be resolved via RxNav "
              f"(not in RxNorm, or rate-limited -- rerun this script to retry rate-limited ones).")
    if rate_limited:
        print(f"WARNING: {rate_limited} requests rate-limited this run; rerun to retry them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
