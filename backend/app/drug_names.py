"""Reference-image NDC -> drug-info lookup.

Loads the precomputed table built by scripts/build_ndc_names.py (sourced from
the NIH RxNav API). Lookup is offline and instant; if the table is missing or an
NDC isn't found, callers fall back to showing the raw NDC code.

The lookup key is the NDC parsed from the *reference image filename* (every
predicted class has one), which is more reliable than the model's class label —
many labels are opaque hashes while the image filenames carry real NDC codes.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional, TypedDict

_TABLE_PATH = Path(__file__).resolve().parent / "data" / "ndc_names.json"


class DrugInfo(TypedDict, total=False):
    name: str
    rxcui: Optional[str]
    imprint: Optional[str]
    color: Optional[str]
    status: Optional[str]
    # Populated by a newer run of scripts/build_ndc_names.py (see its shape/score
    # capture); older entries in ndc_names.json simply won't have these keys,
    # which every reader here treats as "unknown" rather than an error.
    shape: Optional[str]
    score: Optional[str]


def ndc_from_ref_path(ref_path: str) -> str:
    """Extract the NDC token from a reference image path.

    '.../00093-0154-01_PART_1_OF_1_CHAL10_SB_6F29B7BD.jpg' -> '00093-0154-01'
    '.../10544-511_0_0.jpg'                                 -> '10544-511'
    """
    base = os.path.basename(ref_path.replace("\\", "/"))
    return base.split("_", 1)[0]


class DrugNameLookup:
    def __init__(self, table_path: Path = _TABLE_PATH):
        self._table: dict[str, DrugInfo] = {}
        if table_path.exists():
            with open(table_path) as f:
                self._table = json.load(f)
            print(f"[drug_names] Loaded {len(self._table)} NDC entries.")
        else:
            print(
                f"[drug_names] No name table at {table_path}; predictions will "
                "show NDC codes only. Run scripts/build_ndc_names.py to generate it."
            )

    def lookup(self, ref_path: str) -> Optional[DrugInfo]:
        return self._table.get(ndc_from_ref_path(ref_path))

    @property
    def size(self) -> int:
        return len(self._table)
