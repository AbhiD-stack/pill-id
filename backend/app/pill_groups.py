"""Which gallery labels are the same physical pill.

The same pill is listed many times: package sizes (70000-0312, 70000-0312-1),
repackagers, store brands, and the same NDC once as a DailyMed label and
again as an ePillID label (a content hash whose image filenames carry the
NDC). Without grouping, one pill can take several of the top-5 slots, and
a listing with no drug info can't be recognized as a duplicate of one that
has it.

Two listings are grouped when either
  1. they share an NDC product code (labeler-product, normalized to 5-4)
     -- from the label itself, or from ePillID image filenames; or
  2. they carry the same imprint, colors and shape AND their drug names
     share an ingredient word. Look-alike pills of different drugs exist
     (yellow "S 10" is both empagliflozin and tadalafil; white "C 25" is
     chlorthalidone, clindamycin and meclizine), so a matching appearance
     alone never merges two drugs.
Every merge -- rule 1 too, since some NDC product codes in the data were
reused for different drugs -- requires that all named listings on both
sides share an ingredient word, so merges can't chain across drugs.

Each group gets one display info (the most complete listing's), so a
listing with no info of its own borrows its group's name and imprint.
"""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Iterable, Optional

from drug_names import DrugInfo, DrugNameLookup, _color_set, _imprint_tokens, _name_words, ndc_from_ref_path

_NDC = re.compile(r"^(\d{4,5})-(\d{3,4})")

def ndc9(token: Optional[str]) -> Optional[str]:
    m = _NDC.match(token or "")
    return f"{m.group(1).zfill(5)}-{m.group(2).zfill(4)}" if m else None


def _shape(info: DrugInfo) -> str:
    return re.sub(r"[^a-z]", "", re.sub(r"\([^)]*\)", "", (info.get("shape") or "").lower()))


def _completeness(info: DrugInfo) -> int:
    return sum(bool(info.get(k)) for k in ("name", "imprint", "color", "shape", "score_marks"))


class PillGroups:
    def __init__(self, labels: Iterable[str], ref_paths_by_label: dict[str, list[str]], names: DrugNameLookup):
        labels = [str(l) for l in labels]
        self._parent = {l: l for l in labels}

        # NDC products per label: the label itself, or ePillID filenames.
        ndcs: dict[str, set[str]] = defaultdict(set)
        for l in labels:
            if ndc9(l):
                ndcs[l].add(ndc9(l))
            elif not l.startswith("BRAND:"):
                for p in ref_paths_by_label.get(l, []):
                    if "ePillID_data" in p and ndc9(ndc_from_ref_path(p)):
                        ndcs[l].add(ndc9(ndc_from_ref_path(p)))
        table_by_ndc: dict[str, list[str]] = defaultdict(list)
        for k in names._table:
            if ndc9(k):
                table_by_ndc[ndc9(k)].append(k)

        # Info per label: its own entry, else one for its NDC product.
        own: dict[str, DrugInfo] = {}
        for l in labels:
            info = names.lookup_by_label(l)
            if info is None:
                for n in sorted(ndcs.get(l, ())):
                    if table_by_ndc.get(n):
                        info = names.lookup_by_label(table_by_ndc[n][0])
                        break
            if info:
                own[l] = info
        self._own = own
        # Name words of every named listing in each group (by root), so a
        # merge can check that EVERY name in one group agrees with EVERY name
        # in the other -- otherwise chains (A~B, B~C) could join two
        # different drugs A and C.
        self._words: dict[str, list[frozenset]] = {
            l: [frozenset(_name_words(own[l]))] for l in labels if own.get(l) and _name_words(own[l])
        }

        # 1. Same NDC product -- unless the names contradict: the data has
        # NDC product codes reused for different drugs (naratriptan and
        # ondansetron both under 23155-0055), which must stay separate.
        reps_by_ndc: dict[str, list[str]] = defaultdict(list)
        for l in labels:
            for n in sorted(ndcs.get(l, ())):
                for r in reps_by_ndc[n]:
                    if self._try_union(l, r):
                        break
                else:
                    reps_by_ndc[n].append(l)

        # 2. Same appearance AND agreeing drug names.
        reps: dict[tuple, list[str]] = defaultdict(list)
        for l in labels:
            info = own.get(l)
            if not info or not _name_words(info):
                continue
            imprint = tuple(sorted(_imprint_tokens(info.get("imprint"))))
            if not imprint:
                continue
            keys = [(imprint, _color_set(info.get("color")), _shape(info))]
            if sum(len(t) for t in imprint) >= 3:
                # A distinctive imprint on the same drug is the same pill even
                # when listings record color/shape differently ("WHITE" vs
                # missing), or split the imprint differently
                # ("Westward;3142" vs "West;ward;3142").
                keys.append((imprint,))
                keys.append(("compact", "".join(_imprint_tokens(info.get("imprint")))))
            for key in keys:
                for r in reps[key]:
                    if self._try_union(l, r):
                        break
                else:
                    reps[key].append(l)

        # Group membership and display info.
        self.members: dict[str, list[str]] = defaultdict(list)
        for l in labels:
            self.members[self._find(l)].append(l)
        self.group_of = {l: self._find(l) for l in labels}
        self._info: dict[str, DrugInfo] = {}
        for g, ls in self.members.items():
            infos = [own[l] for l in ls if l in own]
            if infos:
                self._info[g] = max(infos, key=_completeness)

    def _find(self, x: str) -> str:
        while self._parent[x] != x:
            self._parent[x] = self._parent[self._parent[x]]
            x = self._parent[x]
        return x

    def _try_union(self, a: str, b: str) -> bool:
        """Merge a's and b's groups if every named listing of one shares an
        ingredient word with every named listing of the other (a listing
        with no name contradicts nothing). Returns whether they're merged."""
        ra, rb = self._find(a), self._find(b)
        if ra == rb:
            return True
        wa, wb = self._words.get(ra, []), self._words.get(rb, [])
        if not all(x & y for x in wa for y in wb):
            return False
        self._parent[ra] = rb
        if wa:
            self._words[rb] = wb + wa
            self._words.pop(ra, None)
        return True

    def key(self, label: str) -> tuple:
        g = self.group_of.get(label)
        return ("group", g) if g is not None else ("label", label)

    def info(self, label: str) -> Optional[DrugInfo]:
        """The label's own info, else its group's."""
        own = self._own.get(label)
        if own:
            return own
        g = self.group_of.get(label)
        return self._info.get(g) if g is not None else None

    def also_sold_as(self, label: str, limit: int = 4) -> list[str]:
        g = self.group_of.get(label)
        primary = self.info(label)
        if g is None or not primary:
            return []
        norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
        seen = {norm(primary.get("name"))}
        out = []
        for l in self.members[g]:
            name = (self._own.get(l) or {}).get("name")
            if name and norm(name) not in seen:
                seen.add(norm(name))
                out.append(name)
        return out[:limit]
