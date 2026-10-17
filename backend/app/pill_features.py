"""Reads a pill's color and shape straight from the photo's pixels.

Independent of the recognition model on purpose: the FDA records every
pill's color and shape, so a confirmed color/shape finds the right pill even
when its only reference picture is a box. Results are SUGGESTIONS the user
confirms or corrects -- phone lighting can shift colors, so nothing here is
ever used to rule a pill out on its own.

Pipeline: trim black letterboxing -> GrabCut the pill from the background
-> white-balance against the background when it is a neutral surface ->
cluster the pill's pixels and name each cluster with the FDA color words ->
classify the outline (round / oval / capsule / polygon) from its geometry.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

try:
    import cv2
except ImportError:  # opencv comes with easyocr; without it there is no reading
    cv2 = None

# The FDA (SPL) color vocabulary.
FDA_COLORS = ("WHITE", "GRAY", "BLACK", "RED", "PINK", "ORANGE", "YELLOW",
              "BROWN", "GREEN", "TURQUOISE", "BLUE", "PURPLE")
FDA_SHAPES = ("ROUND", "OVAL", "CAPSULE", "RECTANGLE", "TRIANGLE", "SQUARE", "DIAMOND", "HEXAGON",
              "PENTAGON", "OCTAGON", "TEAR", "BULLET", "FREEFORM", "DOUBLE CIRCLE", "SEMI-CIRCLE", "TRAPEZOID")


# Measured on 993 real phone photos (ePillID consumer set) against the FDA
# colors on record: one namer alone gets the main color right ~57% of the
# time; when the two namers below agree (57% of photos) it is right 78% of
# the time -- so only then is a color suggested. Shape: 77% exact, ~90%
# within the oval/capsule family the FDA records themselves mix up.
_PROTOTYPES = Path(__file__).resolve().parent / "data" / "color_prototypes.json"
_KNN_K = 40
_KNN_MIN_SHARE = 0.6
# Limits for judge_pill_photo, each set so ~97-99% of 1,900 real NIH /
# ePillID pill photos pass it: edge density on the object (imprints and
# score lines stay below; text on boxes/bottles doesn't), contrast with the
# backdrop (a diagram is the same paper as its background), black ink share.
_MAX_INNER_EDGES = 0.08
_MIN_CONTRAST = 20.0
_MAX_INK = 0.06

# Color pairs a camera (or the FDA's own wording) easily swaps; used only by
# photo_matches_record, which must not reject a correct photo over them.
_NEAR = [{"ORANGE", "BROWN", "YELLOW"}, {"WHITE", "GRAY"}, {"WHITE", "YELLOW"}, {"PINK", "RED"},
         {"PINK", "ORANGE"}, {"BLUE", "TURQUOISE"}, {"GREEN", "TURQUOISE"}, {"PURPLE", "PINK"}, {"BROWN", "RED"}]


@dataclass
class PillFeatures:
    colors: list[str] = field(default_factory=list)  # confident FDA color words (main first); [] = unsure
    shape: Optional[str] = None                      # FDA shape word, or None if unsure
    clusters: list = field(default_factory=list)     # (share, rule color name, RGB) of the pill's color clusters
    debug: dict = field(default_factory=dict)


def available() -> bool:
    return cv2 is not None


def _trim_letterbox(rgb: np.ndarray) -> np.ndarray:
    dark = rgb.max(axis=2) < 12
    rows = np.where(~dark.all(axis=1))[0]
    cols = np.where(~dark.all(axis=0))[0]
    if len(rows) < 16 or len(cols) < 16:
        return rgb
    return rgb[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]


def _largest_component(mask: np.ndarray) -> np.ndarray:
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    if n <= 1:
        return mask.astype(bool)
    keep = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    out = lab == keep
    # fill holes (imprint letters, score lines)
    filled = out.astype(np.uint8)
    contours, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    return filled.astype(bool)


def _segment(rgb: np.ndarray) -> Optional[np.ndarray]:
    h, w = rgb.shape[:2]
    if min(h, w) < 16 or rgb.astype(np.float32).std() < 1.5:  # blank / nearly blank photo
        return None
    m = max(2, int(round(min(h, w) * 0.04)))
    mask = np.full((h, w), cv2.GC_PR_FGD, np.uint8)
    mask[:m, :] = mask[-m:, :] = cv2.GC_BGD
    mask[:, :m] = mask[:, -m:] = cv2.GC_BGD
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    # GrabCut's color models never converge (it hangs) on regions of exactly
    # identical pixels -- e.g. a flat studio background. A +-2 level of fixed
    # noise, invisible in the result, keeps them well-defined.
    noise = np.random.default_rng(0).integers(-2, 3, rgb.shape, dtype=np.int16)
    jittered = np.clip(rgb.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    try:
        cv2.grabCut(cv2.cvtColor(jittered, cv2.COLOR_RGB2BGR), mask, None, bgd, fgd, 4, cv2.GC_INIT_WITH_MASK)
    except cv2.error:
        return None
    fg = (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)
    fg = cv2.morphologyEx(fg.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)
    fg = _largest_component(fg)
    share = fg.mean()
    if share < 0.04 or share > 0.97:
        return None
    return fg


def _white_balance(rgb: np.ndarray, fg: np.ndarray) -> np.ndarray:
    """Use the background as a white/gray reference when it is a neutral
    surface (paper, counter, tray). A colored background gives no reference;
    then the photo is left as is."""
    bg = rgb[~fg].reshape(-1, 3).astype(np.float32)
    if len(bg) < 200:
        return rgb
    med = np.median(bg, axis=0)
    if med.mean() < 60:  # dark background: no usable reference
        return rgb
    chroma = (med.max() - med.min()) / max(med.max(), 1)
    if chroma > 0.25:  # clearly colored background
        return rgb
    gain = np.clip(med.mean() / np.maximum(med, 1), 0.75, 1.33)
    return np.clip(rgb.astype(np.float32) * gain, 0, 255).astype(np.uint8)


def _name_color(rgb_center: np.ndarray) -> str:
    """FDA color word for one RGB color."""
    hsv = cv2.cvtColor(np.uint8([[rgb_center]]), cv2.COLOR_RGB2HSV)[0, 0]
    hue, sat, val = float(hsv[0]) * 2.0, float(hsv[1]) / 255.0, float(hsv[2]) / 255.0
    if val < 0.18:
        return "BLACK"
    if sat < 0.14 or (sat < 0.2 and val > 0.8):
        return "WHITE" if val > 0.55 else "GRAY"
    if hue < 12 or hue >= 340:
        if val < 0.45:
            return "BROWN" if sat > 0.35 else "GRAY"
        return "PINK" if sat < 0.5 and val > 0.6 else "RED"
    if hue < 42:
        if val < 0.6 or (sat < 0.45 and val < 0.75):
            return "BROWN"
        return "ORANGE" if hue < 32 or sat > 0.6 else "YELLOW"
    if hue < 70:
        return "BROWN" if val < 0.45 else "YELLOW"
    if hue < 160:
        return "GREEN"
    if hue < 190:
        return "TURQUOISE"
    if hue < 255:
        return "BLUE"
    if hue < 295:
        return "PURPLE"
    return "PINK"


_knn = None


def _knn_color(rgb: np.ndarray) -> tuple[Optional[str], float]:
    """Nearest reference pills (by Lab color) vote on the FDA color name.
    Returns (name, vote share)."""
    global _knn
    if _knn is None:
        try:
            data = json.loads(_PROTOTYPES.read_text())
            arr = np.array(data["lab"], dtype=np.float32)
            _knn = (arr[:, :3], arr[:, 3].astype(int), data["colors"])
        except (OSError, ValueError, KeyError):
            _knn = (np.zeros((0, 3), np.float32), np.zeros(0, int), list(FDA_COLORS))
    X, y, names = _knn
    if len(X) == 0:
        return None, 0.0
    lab = cv2.cvtColor(np.uint8([[rgb]]), cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)
    mu, sd = X.mean(0), X.std(0) + 1e-6
    d = np.linalg.norm((X - lab) / sd, axis=1)
    idx = np.argsort(d)[:_KNN_K]
    votes = np.bincount(y[idx], weights=1 / (d[idx] + 1e-3), minlength=len(names))
    best = int(np.argmax(votes))
    return names[best], float(votes[best] / votes.sum())


def _colors(rgb: np.ndarray, fg: np.ndarray) -> tuple[list[str], list, dict]:
    # Stay away from the outline (background bleed, shadow).
    inner = cv2.erode(fg.astype(np.uint8), np.ones((5, 5), np.uint8), iterations=2).astype(bool)
    if inner.sum() < 100:
        inner = fg
    px = rgb[inner].reshape(-1, 3).astype(np.float32)
    if len(px) > 6000:
        px = px[np.random.default_rng(0).choice(len(px), 6000, replace=False)]
    lab = cv2.cvtColor(px.reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)
    k = 3
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, labels, _ = cv2.kmeans(lab, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.ravel()
    clusters = []
    for c in range(k):
        sel = labels == c
        if sel.any():
            med = np.median(px[sel], axis=0).astype(np.uint8)
            clusters.append((float(sel.mean()), _name_color(med), med))
    clusters.sort(key=lambda t: -t[0])
    main_rgb = clusters[0][2]
    rule, (knn, vote) = clusters[0][1], _knn_color(main_rgb)
    out: list[str] = []
    if rule == knn and vote >= _KNN_MIN_SHARE:  # two independent namers agree
        out.append(rule)
        # A second color only for a real two-tone pill: a big cluster that is
        # clearly a different color (not shadow, glare or the imprint).
        if len(clusters) > 1:
            share2, name2, rgb2 = clusters[1]
            lab = lambda c: cv2.cvtColor(np.uint8([[c]]), cv2.COLOR_RGB2LAB)[0, 0].astype(float)
            if (share2 >= 0.28 and np.linalg.norm(lab(main_rgb) - lab(rgb2)) > 40
                    and name2 != rule and name2 not in ("GRAY", "BLACK")):
                out.append(name2)
    dbg = {"rule": rule, "knn": knn, "knn_vote": round(vote, 2),
           "clusters": [(round(s, 2), n) for s, n, _ in clusters]}
    return out, clusters, dbg


def _shape(fg: np.ndarray) -> tuple[Optional[str], dict]:
    contours, _ = cv2.findContours(fg.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None, {}
    c = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(c)
    (_, _), (rw, rh), _ = cv2.minAreaRect(c)
    if min(rw, rh) < 8:
        return None, {}
    aspect = max(rw, rh) / min(rw, rh)
    rect_fill = area / (rw * rh)
    hull = cv2.convexHull(c)
    solidity = area / max(cv2.contourArea(hull), 1)
    peri = cv2.arcLength(hull, True)
    circularity = 4 * np.pi * cv2.contourArea(hull) / max(peri * peri, 1)
    corners = len(cv2.approxPolyDP(hull, 0.035 * peri, True))
    info = {"aspect": round(aspect, 2), "rect_fill": round(rect_fill, 2), "solidity": round(solidity, 2),
            "circularity": round(circularity, 2), "corners": corners}
    if solidity < 0.85:  # outline not clean enough to judge
        return None, info
    if aspect < 1.18:
        if circularity > 0.86:
            return "ROUND", info
        named = {3: "TRIANGLE", 4: "SQUARE" if rect_fill > 0.85 else "DIAMOND", 5: "PENTAGON",
                 6: "HEXAGON", 8: "OCTAGON"}
        return named.get(corners), info
    # Elongated: an ellipse fills ~79% of its bounding box, a capsule
    # (rectangle with round ends) 87-93%, a rectangle ~100%. Real outlines
    # are blurrier; 0.88 is the best oval/capsule split measured on photos.
    if rect_fill < 0.88:
        return "OVAL", info
    if rect_fill < 0.95:
        return "CAPSULE", info
    return "RECTANGLE", info


def analyze(image: Image.Image) -> Optional[PillFeatures]:
    """Color and shape of the pill in a (cropped) photo, or None when the
    pill can't be separated from the background reliably."""
    if cv2 is None:
        return None
    cv2.setRNGSeed(0)  # GrabCut/k-means: same photo, same answer (per thread)
    img = image.convert("RGB")
    img.thumbnail((256, 256))
    rgb = _trim_letterbox(np.asarray(img))
    fg = _segment(rgb)
    if fg is None:
        return None
    balanced = _white_balance(rgb, fg)
    colors, clusters, cdbg = _colors(balanced, fg)
    shape, sdbg = _shape(fg)
    # Printed detail on the object: text and graphics on a box or bottle make
    # many edges; a pill has at most an imprint and a score line.
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    inner = cv2.erode(fg.astype(np.uint8), np.ones((5, 5), np.uint8), iterations=1).astype(bool)
    edges = cv2.Canny(gray, 60, 150) > 0
    sdbg["inner_edges"] = round(float(edges[inner].mean()) if inner.any() else 0.0, 3)
    # Does the object stand out from its backdrop (a pill), or is it the same
    # paper with lines on it (a diagram)? And how much of it is black ink?
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)
    fgm, bgm = fg.reshape(-1), ~fg.reshape(-1)
    sdbg["contrast"] = round(float(np.linalg.norm(np.median(lab[fgm], 0) - np.median(lab[bgm], 0))) if bgm.any() else 0.0, 1)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).reshape(-1, 3)
    ink = (hsv[:, 2] < 70) & (hsv[:, 1] < 70)
    sdbg["ink"] = round(float(ink[fgm].mean()), 3)
    return PillFeatures(colors=colors, shape=shape, clusters=clusters,
                        debug={**cdbg, **sdbg, "fg_share": round(float(fg.mean()), 2)})


def crop_to_pill(image: Image.Image, margin: float = 0.3) -> Image.Image:
    """The pill and some background around it -- like the app's crop box --
    for photos taken without cropping. Unchanged if no pill is found."""
    if cv2 is None:
        return image
    cv2.setRNGSeed(0)
    small = image.convert("RGB")
    small.thumbnail((256, 256))
    fg = _segment(np.asarray(small))
    if fg is None:
        return image
    ys, xs = np.where(fg)
    sx, sy = image.width / small.width, image.height / small.height
    x0, x1, y0, y1 = xs.min() * sx, (xs.max() + 1) * sx, ys.min() * sy, (ys.max() + 1) * sy
    side = max(x1 - x0, y1 - y0) * (1 + 2 * margin)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    box = (int(max(0, cx - side / 2)), int(max(0, cy - side / 2)),
           int(min(image.width, cx + side / 2)), int(min(image.height, cy + side / 2)))
    return image.crop(box)


def photo_matches_record(image: Image.Image, fda_color: Optional[str]) -> Optional[bool]:
    """Could this photo show a pill with this FDA color? False only when no
    sizable part of the pill has that color or a commonly confused one (on
    reference photos: keeps 92% of correct photos, catches 70% of photos of
    a differently colored pill). None when it can't tell."""
    import re

    fda = [w for w in (re.split(r"[\s(]", p.strip().upper())[0] for p in (fda_color or "").split(",")) if w in FDA_COLORS]
    if not fda:
        return None
    f = analyze(image)
    if f is None or not f.clusters:
        return None
    near = lambda a, b: a == b or any(a in s and b in s for s in _NEAR)
    return any(share >= 0.15 and any(near(name, c) for c in fda) for share, name, _ in f.clusters)


def judge_pill_photo(image: Image.Image, fda_color: Optional[str], fda_shape: Optional[str]
                     ) -> tuple[bool, str]:
    """Is this image a photo of THIS pill? Checked from the pixels alone
    (the recognition model can't tell a manufacturer's pill photo from
    package art -- it separates image sources, not content):
      - one clear object on a plain background, not filling the picture,
      - a clean pill outline (not a box: no 4-cornered rectangle unless the
        pill itself is rectangular; little printed detail on it),
      - its color AND shape agree with the FDA record for this pill (so a
        photo of a different strength or a white bottle doesn't pass).
    Returns (ok, reason)."""
    import re

    from drug_names import shape_agreement

    fda = [w for w in (re.split(r"[\s(]", p.strip().upper())[0] for p in (fda_color or "").split(",")) if w in FDA_COLORS]
    if not fda:
        return False, "no FDA color on record to check against"
    f = analyze(image)
    if f is None:
        return False, "no clear object"
    d = f.debug
    if not 0.03 <= d.get("fg_share", 0) <= 0.92:
        return False, "object fills the picture (package?)"
    if d.get("solidity", 0) < 0.9 or f.shape is None:
        return False, "outline is not pill-like"
    if d.get("inner_edges", 1) > _MAX_INNER_EDGES:
        return False, "printed detail on the object (package?)"
    if d.get("contrast", 0) < _MIN_CONTRAST:
        return False, "object doesn't stand out from the backdrop (diagram?)"
    if d.get("ink", 1) > _MAX_INK:
        return False, "mostly black ink (diagram/text?)"
    if f.shape in ("RECTANGLE", "SQUARE") and shape_agreement(f.shape, fda_shape) != 1.0:
        return False, "box-shaped"
    near = lambda a, b: a == b or any(a in s and b in s for s in _NEAR)
    if not any(share >= 0.15 and any(near(name, c) for c in fda) for share, name, _ in f.clusters):
        return False, f"color disagrees with FDA record ({fda_color})"
    sa = shape_agreement(f.shape, fda_shape)
    if sa is not None and sa < 0.5:
        return False, f"shape disagrees with FDA record ({fda_shape})"
    return True, "ok"

