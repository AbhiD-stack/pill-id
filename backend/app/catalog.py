"""In-memory medication catalog for non-image search paths (V3).

Built once at startup from the same data the image classifier already loads
(reference-image labels/paths + the NDC drug-name table) -- no new data
source, just a different index over it. Powers:
  - name search ("what does my ibuprofen look like right now?")
  - attribute/filter search (shape, color, imprint, score marks) as an
    Epocrates-style backup when a photo scan doesn't turn up the right pill
  - OCR candidate matching (see ocr.py)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
import torch

from drug_names import DrugNameLookup, ndc_from_ref_path


@dataclass
class CatalogEntry:
    label: str
    ndc: str
    name: Optional[str]
    imprint: Optional[str]
    color: Optional[str]
    shape: Optional[str]
    score_marks: Optional[str]
    status: Optional[str]
    ref_paths: List[str] = field(default_factory=list)


class MedicationCatalog:
    def __init__(
        self,
        label_strings: np.ndarray,
        ref_abs_paths: np.ndarray,
        ref_label_indices: torch.Tensor,
        drug_names: DrugNameLookup,
    ):
        by_label: Dict[int, List[str]] = {}
        for path, label_idx in zip(ref_abs_paths.tolist(), ref_label_indices.tolist()):
            by_label.setdefault(int(label_idx), []).append(str(path))

        self.entries: Dict[str, CatalogEntry] = {}
        for idx, label in enumerate(label_strings):
            label = str(label)
            paths = by_label.get(idx, [])
            sample_path = paths[0] if paths else label
            info = drug_names.lookup(sample_path) or {}
            self.entries[label] = CatalogEntry(
                label=label,
                ndc=ndc_from_ref_path(sample_path),
                name=info.get("name"),
                imprint=info.get("imprint"),
                color=info.get("color"),
                shape=info.get("shape"),
                score_marks=info.get("score"),
                status=info.get("status"),
                ref_paths=paths,
            )
        print(f"[catalog] Built {len(self.entries)} medication entries for name/attribute search.")

    def search_by_name(self, query: str, limit: int = 20) -> List[CatalogEntry]:
        q = query.strip().lower()
        if not q:
            return []
        scored = []
        for e in self.entries.values():
            haystack = " ".join(filter(None, [e.name, e.ndc, e.label])).lower()
            if q in haystack:
                # Exact/prefix name matches first, then substring matches.
                name = (e.name or "").lower()
                rank = 0 if name == q else (1 if name.startswith(q) else 2)
                scored.append((rank, e))
        scored.sort(key=lambda t: t[0])
        return [e for _, e in scored[:limit]]

    def search_by_attributes(
        self,
        color: Optional[str] = None,
        shape: Optional[str] = None,
        imprint: Optional[str] = None,
        score_marks: Optional[str] = None,
        limit: int = 20,
    ) -> List[CatalogEntry]:
        def norm(x: Optional[str]) -> str:
            return (x or "").strip().lower()

        color, shape, imprint, score_marks = norm(color), norm(shape), norm(imprint), norm(score_marks)
        if not any([color, shape, imprint, score_marks]):
            return []
        out: List[CatalogEntry] = []
        for e in self.entries.values():
            if color and color not in norm(e.color):
                continue
            if shape and shape not in norm(e.shape):
                continue
            if imprint and imprint not in norm(e.imprint):
                continue
            if score_marks and score_marks not in norm(e.score_marks):
                continue
            out.append(e)
            if len(out) >= limit:
                break
        return out

    def get(self, label_or_ndc: str) -> Optional[CatalogEntry]:
        if label_or_ndc in self.entries:
            return self.entries[label_or_ndc]
        for e in self.entries.values():
            if e.ndc == label_or_ndc:
                return e
        return None
