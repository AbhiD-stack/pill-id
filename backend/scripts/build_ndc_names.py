"""Precompute an NDC -> drug-info lookup table for the model's reference pills.

For each reference image the model can return, we parse the NDC from its filename
and resolve drug info via the NIH RxNav API:
  - ndcproperties (ndcstatus=ALL) -> rxcui + imprint code + color (handles
    obsolete products and 9-digit product NDCs, unlike openFDA's NDC directory)
  - rxcui -> RxNorm drug name

Writes app/data/ndc_names.json keyed by the NDC token as parsed from the image
filename (see app.drug_names.ndc_from_ref_path). Resumable: rerun to retry any
NDCs that were rate-limited in a previous run.

Run from the backend/ directory:
    PYTHONPATH=. .venv/bin/python -u scripts/build_ndc_names.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import torch

from app.drug_names import ndc_from_ref_path

REPO_ROOT = Path(__file__).resolve().parents[2]
REF = REPO_ROOT / "dinov2_projection_head" / "deployed_ref_embeddings.pt"
OUT = Path(__file__).resolve().parents[1] / "app" / "data" / "ndc_names.json"
CHECKED = OUT.with_suffix(".checked.json")
BASE = "https://rxnav.nlm.nih.gov/REST"


class RateLimited(Exception):
    pass


def _get(url: str) -> dict:
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=20) as resp:
                return json.load(resp)
        except Exception:
            time.sleep(2 ** attempt)  # 1,2,4,8,16s
    raise RateLimited(url)


def _candidates(token: str) -> list[str]:
    """NDC id forms to try against ndcproperties (most specific first)."""
    parts = token.split("-")
    cands: list[str] = []
    if len(parts) >= 2:
        cands.append(f"{parts[0].zfill(5)}-{parts[1].zfill(4)}")  # ndc9
    cands.append(token)
    # de-dup preserving order
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
    """Find a propertyConceptList value by substring match on its propName.

    We only have verified propName keys for IMPRINT_CODE/COLORTEXT/NDC_STATUS
    (used below, from the existing working lookup). RxNav's exact key for
    shape/scoring isn't confirmed against a live response here, so rather than
    hardcode a guessed exact key that might silently never match, we scan for
    any propName containing the given substring(s) -- e.g. a key like "SHAPE"
    or "SPLSHAPE_TEXT" both match substring "SHAPE". Spot-check a few results
    the first time you run this against real data.
    """
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
    ref = torch.load(REF, map_location="cpu")
    tokens = sorted({ndc_from_ref_path(str(p)) for p in ref["abs_paths"]})

    table: dict[str, dict] = json.load(open(OUT)) if OUT.exists() else {}
    checked: set[str] = set(json.load(open(CHECKED))) if CHECKED.exists() else set()
    todo = [t for t in tokens if t not in table and t not in checked]
    print(f"{len(tokens)} unique NDCs; {len(table)} named, {len(todo)} to fetch")

    rx_cache: dict[str, str | None] = {}
    resolved = rate_limited = 0
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(resolve, t, rx_cache) for t in todo]
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                token, info = fut.result()
                checked.add(token)
                if info:
                    table[token] = info
                    resolved += 1
            except RateLimited:
                rate_limited += 1
            if i % 250 == 0:
                print(f"  {i}/{len(todo)} processed, {resolved} resolved, "
                      f"{rate_limited} rate-limited")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    json.dump(table, open(OUT, "w"), indent=0, sort_keys=True)
    json.dump(sorted(checked), open(CHECKED, "w"))
    print(f"Wrote {len(table)}/{len(tokens)} names to {OUT}")
    if rate_limited:
        print(f"WARNING: {rate_limited} rate-limited; rerun to retry them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
