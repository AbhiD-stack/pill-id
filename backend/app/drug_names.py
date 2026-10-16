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
import re
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


_NDC_RE = re.compile(r"^\d{4,5}-\d{3,4}(-\d{1,2})?$")


def display_ndc(label: str) -> Optional[str]:
    """The label when it's an actual NDC; None for the gallery's non-NDC
    labels (e.g. 56-char content hashes), which aren't meaningful to show."""
    return label if _NDC_RE.match(label) else None


_COLOR_WORDS = ("white", "yellow", "orange", "pink", "red", "brown", "blue", "green",
                "purple", "gray", "turquoise", "black")


def _color_set(color: Optional[str]) -> tuple[str, ...]:
    """'BLUE(light blue),RED' / 'red, blue' -> ('blue', 'red')"""
    c = re.sub(r"\([^)]*\)", "", (color or "").lower())
    return tuple(sorted({w for w in _COLOR_WORDS if w in c}))


def _shape_word(shape: Optional[str]) -> str:
    """'HEXAGON (6 SIDED)' / 'capsule ' -> 'hexagon' / 'capsule'"""
    return re.sub(r"[^a-z]", "", re.sub(r"\([^)]*\)", "", (shape or "").lower()))


def color_agreement(colors: Optional[list[str]], fda_color: Optional[str]) -> Optional[float]:
    """How well colors the user confirmed agree with the FDA record:
    1 same colors, 0.5 some in common, 0 none, None if either is unknown."""
    mine = {c.lower() for c in colors or [] if c}
    theirs = set(_color_set(fda_color))
    if not mine or not theirs:
        return None
    if mine == theirs:
        return 1.0
    return 0.5 if mine & theirs else 0.0


def shape_agreement(shape: Optional[str], fda_shape: Optional[str]) -> Optional[float]:
    """1 same shape, 0.5 oval vs capsule (the FDA records use these two
    inconsistently for the same elongated tablets), 0 different, None unknown."""
    a, b = _shape_word(shape), _shape_word(fda_shape)
    if not a or not b:
        return None
    if a == b:
        return 1.0
    return 0.5 if {a, b} == {"oval", "capsule"} else 0.0


# Words that don't identify a drug (forms, salts, marketing words).
_STOP = {
    "tablet", "tablets", "capsule", "capsules", "oral", "extended", "release", "delayed", "film", "coated",
    "chewable", "orally", "disintegrating", "hydrochloride", "sodium", "potassium", "calcium", "magnesium",
    "sulfate", "maleate", "mesylate", "besylate", "tartrate", "succinate", "citrate", "phosphate", "acetate",
    "bromide", "fumarate", "strength", "extra", "regular", "maximum", "dose", "unit", "relief", "adult",
    "adults", "children", "childrens", "junior", "night", "time", "day", "formula", "caplet", "caplets",
    "softgel", "softgels", "gelcap", "gelcaps", "pack", "kit", "with", "and", "plus", "free", "leader",
    "topcare", "equaline", "sunmark", "kirkland", "signature", "care", "health", "good", "sense", "quality",
    "choice", "rite", "aid", "walgreens", "member", "major", "basics",
}


def _name_words(info: Optional[DrugInfo]) -> set[str]:
    """Words that identify the drug in its name (not forms, salts or brands)."""
    words = re.findall(r"[a-z]+", ((info or {}).get("name") or "").lower())
    return {w for w in words if len(w) >= 4 and w not in _STOP}


def pill_key(label: str, info: Optional[DrugInfo]) -> tuple:
    """Identity of the physical pill. The same pill is often listed many
    times: package sizes (70000-0312, 70000-0312-1), repackagers, and store
    brands selling one manufacturer's pill under different names (Leader /
    TopCare / DG Health "Migraine Relief" are all the same green-and-white
    "M" pill). A pill is identified by what's physically on it -- imprint,
    colors, shape -- regardless of name, spelling, word order or casing.
    Pills without an imprint can't be told apart that way, so for those the
    name stays part of the key; labels with no info at all group by NDC
    product code (package variants of one product)."""
    if info:
        imprint = tuple(sorted(_imprint_tokens(info.get("imprint"))))
        if imprint:
            # Name words too: different drugs can look identical (yellow
            # "S 10" is both empagliflozin and tadalafil), and merging those
            # would hide one. (PillGroups, when attached, merges store
            # brands of the same pill more completely.)
            return ("pill", imprint, _color_set(info.get("color")), _shape_word(info.get("shape")),
                    tuple(sorted(_name_words(info))))
        norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
        return ("named", norm(info.get("name")), _color_set(info.get("color")), _shape_word(info.get("shape")))
    m = re.match(r"^(\d{4,5}-\d{3,4})(-\d{1,2})?$", label)
    return ("product", m.group(1)) if m else ("label", label)


def group_pills(rows: list, key=lambda row: pill_key(row[0], row[1])) -> list[tuple]:
    """[(first row of each physical pill, [the other rows for that pill]), ...]
    in order of first appearance."""
    groups: dict[tuple, tuple] = {}
    for row in rows:
        k = key(row)
        if k in groups:
            groups[k][1].append(row)
        else:
            groups[k] = (row, [])
    return list(groups.values())


def dedupe_pills(rows: list, key=lambda row: pill_key(row[0], row[1])) -> list:
    return [first for first, _ in group_pills(rows, key)]


def other_names(primary: Optional[DrugInfo], others: list[Optional[DrugInfo]], limit: int = 4) -> list[str]:
    """Distinct names the same pill is also sold under (for "also sold as")."""
    norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
    seen = {norm((primary or {}).get("name"))}
    names = []
    for info in others:
        name = (info or {}).get("name")
        if name and norm(name) not in seen:
            seen.add(norm(name))
            names.append(name)
    return names[:limit]


def _imprint_tokens(s: Optional[str]) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", (s or "").lower()) if t]


def _compact(tokens: list[str]) -> str:
    """"L5", "L 5" and "L;5" all compact to "l5"."""
    return "".join(tokens)


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
        # physical pill -> its labels, for "also sold as" names.
        self._by_pill: dict[tuple, list[str]] = {}
        for label, info in self._table.items():
            self._by_pill.setdefault(pill_key(label, info), []).append(label)

    # Set by the server at startup (pill_groups.PillGroups): which gallery
    # labels are the same physical pill. None = fall back to pill_key.
    groups = None

    def dedupe_key(self, label: str, info: Optional[DrugInfo]) -> tuple:
        return self.groups.key(label) if self.groups is not None else pill_key(label, info)

    def display_info(self, label: str, ref_path: Optional[str] = None) -> Optional[DrugInfo]:
        """Info to show for a label: its own, else its pill group's, else by
        the NDC in its reference image filename."""
        if self.groups is not None:
            info = self.groups.info(label)
            if info:
                return info
        return self.lookup_by_label(label) or (self.lookup(ref_path) if ref_path else None)

    def lookup(self, ref_path: str) -> Optional[DrugInfo]:
        return self._table.get(ndc_from_ref_path(ref_path))

    def lookup_by_label(self, label: str) -> Optional[DrugInfo]:
        """Preferred lookup for the new gallery -- see module docstring."""
        return self._table.get(label)

    def also_sold_as(self, label: str, info: Optional[DrugInfo], limit: int = 4) -> list[str]:
        """Other names the same physical pill is listed under."""
        if self.groups is not None:
            return self.groups.also_sold_as(label, limit)
        if not info:
            return []
        same = self._by_pill.get(pill_key(label, info), [])
        return other_names(info, [self._table[l] for l in same if l != label], limit)

    def search_by_name(self, query: str, limit: int = 20, imprint: Optional[str] = None
                       ) -> list[tuple[str, DrugInfo]]:
        """Case-insensitive substring match against drug name. Returns
        (label, info) pairs, exact-prefix matches first, one per distinct
        pill. imprint (optional) narrows common names -- "acetaminophen"
        alone matches hundreds of different pills -- to those whose imprint
        contains every given token."""
        q = query.strip().lower()
        if not q:
            return []
        want = _imprint_tokens(imprint)
        starts, contains = [], []
        for label, info in self._table.items():
            name = (info.get("name") or "").lower()
            if not name:
                continue
            if want:
                have = _imprint_tokens(info.get("imprint"))
                if not all(w in have for w in want) and _compact(want) not in _compact(have):
                    continue
            if name.startswith(q):
                starts.append((label, info))
            elif q in name:
                contains.append((label, info))
        # Exact name first, then plainer (shorter) names: "acetaminophen"
        # before "acetaminophen / dextromethorphan / doxylamine".
        by_len = lambda row: (len(row[1].get("name") or ""), row[1].get("name") or "")
        exact = [r for r in starts if (r[1].get("name") or "").lower() == q]
        starts = sorted([r for r in starts if (r[1].get("name") or "").lower() != q], key=by_len)
        return dedupe_pills(exact + starts + sorted(contains, key=by_len),
                            key=lambda row: self.dedupe_key(row[0], row[1]))[:limit]

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
        here they're just joined and split back into tokens, each scored on
        its own (see below) -- a strict substring match on the joined string
        would almost never hit, since the real field doesn't preserve "side
        order" the way a two-field form naturally implies.

        color supports multiple selections too (comma/space-separated),
        but AND-matched rather than OR -- e.g. a two-toned capsule that's
        "red on one half, blue on the other" should only match pills whose
        stored color is actually both, not any pill that's merely red OR
        merely blue (which the real data already stores as compound
        strings like "RED,BLUE" for exactly this case)."""
        simple_criteria = [
            ("shape", shape),
            ("score_marks", score_marks),
        ]
        simple_criteria = [(field, val.strip().lower()) for field, val in simple_criteria if val and val.strip()]
        imprint_tokens = _imprint_tokens(imprint)
        color_tokens = [t.strip().lower() for t in re.split(r"[,\s]+", color or "") if t.strip()]
        if not simple_criteria and not imprint_tokens and not color_tokens:
            return []

        scored: list[tuple[str, DrugInfo, int]] = []
        # Tie-break: fewer imprint tokens the user didn't mention first, so
        # typing "L 5" ranks the "L;5" pill above "APO;L;5".
        unmentioned: dict[str, int] = {}
        for label, info in self._table.items():
            count = 0
            for field, val in simple_criteria:
                field_val = (info.get(field) or "").lower()
                if field_val and val in field_val:
                    count += 1
            if imprint_tokens:
                # Each typed token that equals one of the pill's imprint
                # tokens counts 2 (so "L 5" ranks the "L;5" pill above any
                # imprint merely containing an L); a substring hit counts 1.
                stored = _imprint_tokens(info.get("imprint"))
                unmentioned[label] = len([s for s in stored if s not in imprint_tokens])
                token_count = 0
                for tok in imprint_tokens:
                    if tok in stored:
                        token_count += 2
                    elif any(tok in s for s in stored):
                        token_count += 1
                # Spacing differences ("L5" vs "L;5") count as a full match.
                if _compact(imprint_tokens) == _compact(stored):
                    token_count = max(token_count, 2 * len(imprint_tokens), 2)
                    unmentioned[label] = 0
                count += token_count
            if color_tokens:
                stored_color = (info.get("color") or "").lower()
                if stored_color and all(tok in stored_color for tok in color_tokens):
                    count += len(color_tokens)
            if count > 0:
                scored.append((label, info, count))
        scored.sort(key=lambda row: (-row[2], unmentioned.get(row[0], 0)))
        return dedupe_pills(scored, key=lambda row: self.dedupe_key(row[0], row[1]))[:limit]

    def labels_matching_appearance(self, labels, colors: Optional[list[str]], shape: Optional[str]) -> list[str]:
        """Labels (from the given set, e.g. the model's) whose FDA color AND
        shape agree with what the user confirmed. Unknown fields don't
        exclude; a label with neither field known isn't returned."""
        if not hasattr(self, "_appearance"):
            self._appearance = {}
            for l in labels:
                info = self.display_info(str(l))
                if info and (info.get("color") or info.get("shape")):
                    self._appearance[str(l)] = (info.get("color"), info.get("shape"))
        out = []
        for l, (c, s) in self._appearance.items():
            ca, sa = color_agreement(colors, c), shape_agreement(shape, s)
            # A confirmed color must be on record; a missing shape record is
            # common (~10%) and doesn't exclude.
            if (ca == 1.0 if colors else ca is None) and (sa is None or sa >= 0.5) and (colors or sa is not None):
                out.append(l)
        return out

    @property
    def imprint_vocab(self) -> set[str]:
        """Every token that appears in some known imprint (uppercase)."""
        if not hasattr(self, "_vocab"):
            self._vocab = {t.upper() for info in self._table.values() for t in _imprint_tokens(info.get("imprint"))}
        return self._vocab

    @property
    def size(self) -> int:
        return len(self._table)
