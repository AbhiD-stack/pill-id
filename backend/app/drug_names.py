"""Reference-image NDC -> drug-info lookup.

Loads the precomputed table built by scripts/build_ndc_names.py (sourced from
the NIH RxNav API). Lookup is offline and instant; if the table is missing or an
NDC isn't found, callers fall back to showing the raw NDC code.

Two lookup keys are supported:
  - lookup_by_label(label): the model's own predicted class label. Since the
    pill-scanner rebuild's visual-pooling fix, this label is already the
    canonical representative NDC9 for a merged group of NDCs that are the
    same physical pill (same imprint+color) -- it's the right key for the
    new, DailyMed-sourced ndc_names.json table, and the preferred lookup now.
  - lookup(ref_path) / ndc_from_ref_path(ref_path): parses an NDC out of the
    *reference image filename* instead. This was the ONLY option, and the
    correct one, for the old ePillID-only system where label == raw NDC
    exactly. It's kept as a fallback for older tables/checkpoints, but is
    NOT reliable across the new gallery's multiple source datasets (DailyMed,
    C3PI, phvitamins_v2, etc. each name files differently) -- prefer
    lookup_by_label whenever the predicted label is available (it always is).
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
    shape: Optional[str]
    score_marks: Optional[str]
    status: Optional[str]


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

    def lookup_by_label(self, label: str) -> Optional[DrugInfo]:
        """Preferred lookup for the new gallery -- see module docstring."""
        return self._table.get(label)

    @property
    def size(self) -> int:
        return len(self._table)
