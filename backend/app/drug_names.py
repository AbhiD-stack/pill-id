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

    def search_by_name(self, query: str, limit: int = 20) -> list[tuple[str, DrugInfo]]:
        """Case-insensitive substring match against drug name. Returns
        (label, info) pairs, exact-prefix matches first."""
        q = query.strip().lower()
        if not q:
            return []
        starts, contains = [], []
        for label, info in self._table.items():
            name = (info.get("name") or "").lower()
            if not name:
                continue
            if name.startswith(q):
                starts.append((label, info))
            elif q in name:
                contains.append((label, info))
        return (starts + contains)[:limit]

    def search_by_appearance(
        self,
        color: Optional[str] = None,
        shape: Optional[str] = None,
        imprint: Optional[str] = None,
        score_marks: Optional[str] = None,
        limit: int = 20,
    ) -> list[tuple[str, DrugInfo, int]]:
        """Ranks every label by how many of the given (non-empty) criteria
        match, substring/case-insensitive. Returns (label, info, match_count)
        for anything with at least one match, best matches first. This is
        the fallback path for when the photo-based match misses -- the same
        idea as Epocrates' "describe the pill" identifier.

        imprint is treated specially: the stored data has one imprint string
        per pill (often multiple tokens from both faces joined, e.g.
        "L437;PM"), not a per-side breakdown. The UI collects "Side 1" and
        "Side 2" separately for a natural two-sided-pill description, but
        here they're just space-joined and split back into whitespace-
        separated tokens, matched OR-wise (any token present anywhere in the
        stored imprint counts as a hit) -- a strict substring match on the
        joined string would almost never hit, since the real field doesn't
        preserve "side order" the way a two-field form naturally implies."""
        simple_criteria = [
            ("color", color),
            ("shape", shape),
            ("score_marks", score_marks),
        ]
        simple_criteria = [(field, val.strip().lower()) for field, val in simple_criteria if val and val.strip()]
        imprint_tokens = [t.lower() for t in (imprint or "").split() if t.strip()]
        if not simple_criteria and not imprint_tokens:
            return []

        scored: list[tuple[str, DrugInfo, int]] = []
        for label, info in self._table.items():
            count = 0
            for field, val in simple_criteria:
                field_val = (info.get(field) or "").lower()
                if field_val and val in field_val:
                    count += 1
            if imprint_tokens:
                stored_imprint = (info.get("imprint") or "").lower()
                if stored_imprint and any(tok in stored_imprint for tok in imprint_tokens):
                    count += 1
            if count > 0:
                scored.append((label, info, count))
        scored.sort(key=lambda row: row[2], reverse=True)
        return scored[:limit]

    @property
    def size(self) -> int:
        return len(self._table)
