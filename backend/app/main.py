"""FastAPI service for pill identification.

Endpoints:
  GET  /api/health            -> service + model status
  POST /api/predict           -> identify a pill from an uploaded image
  POST /api/embed             -> embeddings for a saved "My Pills" photo
  GET  /api/reference-image   -> matched reference pill thumbnail (from dataset zip)

The model is loaded once at startup and kept warm in memory.
"""
from __future__ import annotations

import io
import json
import re
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from dataclasses import dataclass
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from PIL import Image, UnidentifiedImageError
import numpy as np
import torch

from classifier import DinoV2PillClassifier
from config import get_settings
from collections import defaultdict

from drug_names import DrugNameLookup, color_agreement, dedupe_pills, display_ndc, ndc_from_ref_path, shape_agreement
from pill_groups import PillGroups
from pill_features import FDA_COLORS, FDA_SHAPES, analyze as analyze_pill, judge_pill_photo
from imprint_match import ocr_engine, read_imprint_text, score_imprint_match, warm_up_ocr
from imprint_vision import read_imprint_with_vision, vision_available
from reference_images import ReferenceImageStore, map_to_zip_path
MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB
_MAX_IMPRINT = 60  # typed imprint, both sides; real ones are far shorter

# Populated in the lifespan handler.
state: dict = {"classifier": None, "ref_store": None, "drug_names": None}




@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()

    # `pip install pytesseract` only installs the Python wrapper -- the
    # actual Tesseract OCR engine is a separate program that has to be
    # installed on the host. read_imprint_text() catches every exception and
    # returns None (deliberately, so a missing/broken OCR install degrades
    # to embedding-only scoring instead of crashing predictions), which
    # means this failure mode is otherwise completely silent: the imprint
    # re-ranking signal just never fires, with nothing in the logs to say
    # why. Check it explicitly at startup instead.
    try:
        import pytesseract
        version = pytesseract.get_tesseract_version()
        print(f"[startup] Tesseract OCR engine found (version {version}) -- imprint re-ranking is active.")
    except Exception as e:
        print(
            "[startup] WARNING: Tesseract OCR engine not found or not working "
            f"({e!r}). Imprint-text matching will silently do nothing -- "
            "predictions fall back to pure visual-embedding similarity, which "
            "cannot distinguish same-shape/color pills that differ only in "
            "imprint text. On Windows: install from "
            "https://github.com/UB-Mannheim/tesseract/wiki and make sure "
            "tesseract.exe is on PATH (or set pytesseract.pytesseract.tesseract_cmd)."
        )

    if vision_available():
        print(f"[startup] Imprint reading: {settings.imprint_vision_model} (photos are sent to the Anthropic API).")
    else:
        print(f"[startup] Imprint reading: {ocr_engine()} (free, local)."
              + (" Run `pip install easyocr` for a much better free reader." if ocr_engine() != "easyocr" else ""))

    print("[startup] Loading model... (first run downloads the DINOv2 backbone)")
    state["classifier"] = DinoV2PillClassifier(
        model_dir=settings.model_artifacts_dir,
        device=settings.device,
        lora_adapter_dir=settings.lora_adapter_dir,
        label_meta_path=settings.label_meta_path,
    )
    _load_photo_gallery(state["classifier"], settings)
    _load_contributions(state["classifier"], settings)
    try:
        state["ref_store"] = ReferenceImageStore(settings.dataset_zip_path)
    except (FileNotFoundError, zipfile.BadZipFile):
        # The new gallery's reference images mostly live outside the old
        # ePillID-only zip (DailyMed/C3PI/etc. sources) -- missing (or, e.g.,
        # an un-pulled git-lfs pointer file instead of the real zip) just
        # means thumbnails are unavailable, not that serving is broken.
        print(f"[startup] No usable reference-image zip at {settings.dataset_zip_path} -- "
              "predictions will omit thumbnails.")
        state["ref_store"] = None
    # label -> a real ePillID pill photo inside the dataset zip, so label-
    # keyed lookups (search results, or a match whose *winning* reference
    # image happened to be DailyMed box art) can still show a real photo
    # when one exists for that label.
    # Prefer ePillID's clean NIH reference photos over its consumer (phone)
    # photos, which vary a lot in quality.
    state["epillid_by_label"] = {}
    if state["ref_store"] is not None:
        clf = state["classifier"]
        label_idx = clf.ref_label_indices.cpu().numpy()
        best: dict[str, tuple[int, str]] = {}
        for i, path in enumerate(clf.ref_abs_paths):
            zp = map_to_zip_path(str(path))
            if zp.startswith("ePillID_data/") and state["ref_store"].has(zp):
                label = str(clf.label_strings[label_idx[i]])
                rank = _epillid_photo_rank(zp)
                if label not in best or rank < best[label][0]:
                    best[label] = (rank, zp)
        state["epillid_by_label"] = {label: zp for label, (_, zp) in best.items()}
        print(f"[startup] Real ePillID pill photos available for {len(state['epillid_by_label'])} labels.")
    state["drug_names"] = DrugNameLookup()
    _check_artifacts(state["classifier"], state["drug_names"], settings)

    # Which listings are the same physical pill (merges duplicates in
    # results, lends info and photos across listings).
    groups = attach_pill_groups(state["classifier"], state["drug_names"])
    print(f"[startup] {len(groups.group_of)} listings -> {len(groups.members)} distinct pills.")
    state["drug_names"].appearance_index(state["classifier"].label_strings)  # color/shape lookups
    _build_thumbnail_maps(settings)

    # Load the OCR model now, not on the first scan (EasyOCR's first call
    # loads -- and the very first time downloads -- its model files).
    try:
        warm_up_ocr()
    except Exception as e:
        print(f"[startup] OCR warm-up failed (imprint reading may be slow or unavailable): {e!r}")
    settings.feedback_dir.mkdir(parents=True, exist_ok=True)
    print("[startup] Ready.")
    yield
    if state["ref_store"] is not None:
        state["ref_store"].close()


def _load_photo_gallery(clf: DinoV2PillClassifier, settings) -> None:
    """Real pill photos found in drug labels after training, embedded by
    scripts/build_photo_gallery.py, join the reference gallery so a pill
    whose training images were only package art can be matched against a
    photo of the pill itself."""
    path = settings.photo_gallery_path
    if not path.exists():
        print("[startup] No extra photo gallery (run scripts/build_photo_gallery.py to add "
              "the pill photos found in drug labels).")
        return
    try:
        data = torch.load(path, map_location="cpu")
        if data.get("model_signature") != model_signature(clf):
            print(f"[startup] WARNING: {path.name} was built with a different model -- ignored. "
                  "Rerun scripts/build_photo_gallery.py.")
            return
        n = clf.add_to_gallery(data["embeddings"], data["labels"], data["paths"])
        print(f"[startup] Added {n} real pill photos from drug labels to the reference gallery.")
    except Exception as e:  # a bad file must not stop the server
        print(f"[startup] WARNING: couldn't load {path} ({e!r}) -- continuing without it.")


def _load_contributions(clf: DinoV2PillClassifier, settings) -> None:
    """Shared pill photos from earlier runs that passed the photo check."""
    d = settings.contributions_dir
    if not d.is_dir():
        return
    sig, n, stale = model_signature(clf), 0, 0
    for meta in sorted(d.glob("*.json")):
        try:
            rec = json.loads(meta.read_text())
            if not rec.get("accepted"):
                continue
            if rec.get("model_signature") != sig:
                stale += 1
                continue
            emb = torch.from_numpy(np.load(meta.with_suffix(".npy")))
            n += clf.add_to_gallery(emb, [rec["label"]] * len(emb), [f"contrib/{meta.stem}.jpg"] * len(emb)) > 0
        except Exception as e:  # one bad record must not stop the server
            print(f"[startup] skipped contribution {meta.name}: {e!r}")
    if n or stale:
        print(f"[startup] Added {n} shared pill photos to the reference gallery"
              + (f" ({stale} made with another model version were skipped)" if stale else "") + ".")


def model_signature(clf: DinoV2PillClassifier) -> str:
    """Identifies the model + gallery an embedding file was made with, so
    embeddings from another model version are never mixed in."""
    return f"{clf.ref_embeddings.shape[1]}:{len(clf.label_strings)}:{float(clf.ref_embeddings[0].sum()):.6f}"


def attach_pill_groups(clf: DinoV2PillClassifier, names: DrugNameLookup) -> PillGroups:
    """Group the gallery's labels into physical pills (see pill_groups.py)
    and attach the grouping to the drug table, which then dedupes, names and
    lists alternate names by group. Shared with scripts/eval_real_photos.py."""
    paths: dict[str, list[str]] = defaultdict(list)
    for path, li in zip(clf.ref_abs_paths, clf.ref_label_indices.cpu().tolist()):
        paths[str(clf.label_strings[li])].append(str(path))
    names.groups = PillGroups(clf.label_strings, paths, names)
    return names.groups


def _build_thumbnail_maps(settings) -> None:
    """Per physical pill: the clearest real photo among ALL its listings,
    and a package image from any listing. Lets a listing that only has
    package art -- or no image at all -- show a photo of the pill itself."""
    groups: PillGroups = state["drug_names"].groups
    best: dict[str, tuple[int, str, str]] = {}  # group -> (rank, how, value)

    def offer(label: str, rank: int, how: str, value: str) -> None:
        g = groups.group_of.get(label)
        if g is not None and (g not in best or rank < best[g][0]):
            best[g] = (rank, how, value)

    pill_dir = settings.thumbnails_dir / "pill"
    if pill_dir.is_dir():
        for f in pill_dir.glob("*.jpg"):
            offer(f.stem, -1, "thumb", f.stem)  # C3PI studio photo: the clearest
    for label, zp in state.get("epillid_by_label", {}).items():
        offer(label, _epillid_photo_rank(zp), "zip", zp)
    # Manufacturers' photos of the pill from drug labels: fetched by
    # fetch_label_pill_photos.py, or found among the DailyMed images by
    # collect_thumbnails.py.
    for kind in ("label_pill", "dm_pill"):
        d = settings.thumbnails_dir / kind
        if d.is_dir():
            for f in d.glob("*.jpg"):
                offer(f.stem, 3, kind, f.stem)
    # Photos users confirmed ("Yes, correct" on a scan): a real photo of
    # exactly that pill, used when nothing better exists.
    for label, record_id in _confirmed_photos(settings):
        offer(label, 4, "confirmed", record_id)
    # Photos people shared when setting up a medicine (passed the photo check).
    if settings.contributions_dir.is_dir():
        for meta in sorted(settings.contributions_dir.glob("*.json")):
            try:
                rec = json.loads(meta.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if rec.get("accepted") and (meta.with_suffix(".jpg")).exists():
                offer(rec["label"], 4, "contrib", meta.stem)
    state["photo_by_group"] = {g: (how, value) for g, (_, how, value) in best.items()}

    package: dict[str, tuple[str, str]] = {}
    for kind in ("package", "legacy"):
        d = settings.thumbnails_dir / _THUMB_SUBDIRS[kind]
        if d.is_dir():
            for f in d.glob("*.jpg"):
                g = groups.group_of.get(f.stem)
                if g is not None:
                    package.setdefault(g, (kind, f.stem))
    state["package_by_group"] = package
    n = len(groups.members)
    from_labels = sum(1 for _, how, _v in best.values() if how in ("label_pill", "dm_pill"))
    print(f"[startup] Thumbnails: real pill photo for {len(best)}/{n} pills ({len(best) / max(1, n):.0%}; "
          f"{from_labels} from drug labels), "
          f"package image for {len(set(package) - set(best))} more.")


_RECORD_RE = re.compile(r"^[0-9]+_[0-9a-f]{32}$")


def _confirmed_photos(settings) -> list[tuple[str, str]]:
    """(label, feedback record id) for every scan a user confirmed correct."""
    if not settings.feedback_dir.is_dir():
        return []
    # Only the LAST answer for each scan counts: a user may tap "This is my
    # pill" on one match and then change their mind.
    latest: dict[str, tuple[str, dict]] = {}
    for meta in sorted(settings.feedback_dir.glob("*.json")):  # names start with a timestamp
        if not _RECORD_RE.match(meta.stem):
            continue
        try:
            latest[meta.stem.split("_", 1)[1]] = (meta.stem, json.loads(meta.read_text()))
        except (OSError, json.JSONDecodeError):
            continue
    return [
        (rec["reported_label"], stem)
        for stem, rec in latest.values()
        if rec.get("correct") and rec.get("reported_label") and (settings.feedback_dir / f"{stem}.jpg").exists()
    ]


def _check_artifacts(clf: DinoV2PillClassifier, drug_names: DrugNameLookup, settings) -> None:
    """Loud warnings for mismatched model files, which otherwise don't
    error -- they just quietly return worse matches. (The repo's committed
    dinov2_projection_head/ is the old 4,902-class V1 model; V3 is 31,277
    classes / 366,528 images and must be copied over it or pointed to with
    MODEL_ARTIFACTS_DIR.)"""
    labels = [str(l) for l in clf.label_strings]
    n_refs = int(clf.ref_embeddings.shape[0])
    in_meta = sum(l in clf.label_meta for l in labels) / max(1, len(labels))
    with_info = sum(drug_names.display_info(l) is not None for l in labels) / max(1, len(labels))
    print(f"[startup] Model check: {len(labels)} drugs, {n_refs} gallery images, from {settings.model_artifacts_dir}. "
          f"{in_meta:.0%} have a category, {with_info:.0%} have drug info.")
    problems = []
    if in_meta < 0.99:
        problems.append("most drugs are missing from label_meta.json -- the model files don't match this app's "
                        "data (old V1 files?)")
    if len(labels) < 30000:
        problems.append(f"only {len(labels)} drugs -- this looks like the old V1 model, not V3 (31,277)")
    if clf.ref_embeddings.shape[1] != clf.projection_head.proj[-1].out_features:
        problems.append("gallery embedding size doesn't match the projection head")
    if with_info < 0.9:
        print("[startup] Note: run scripts/fill_missing_drug_info.py once to add names/imprints for the rest.")
    for p in problems:
        print(f"[startup] !!! WARNING: {p}")


app = FastAPI(title="Pill ID API", version="0.1.0", lifespan=lifespan)


_hits: dict[str, list[float]] = defaultdict(list)


@app.middleware("http")
async def rate_limit(request, call_next):
    """Simple per-device limit on the expensive endpoints."""
    if request.method == "POST" and request.url.path in ("/api/predict", "/api/read-imprint", "/api/embed", "/api/contribute", "/api/cohort"):
        who = (request.headers.get("cf-connecting-ip")
               or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
               or (request.client.host if request.client else "?"))
        now = time.time()
        recent = [t for t in _hits[who] if now - t < 60]
        if len(recent) >= get_settings().rate_limit_per_minute:
            return Response('{"detail":"Too many scans in a minute. Please wait a moment and try again."}',
                            status_code=429, media_type="application/json")
        recent.append(now)
        _hits[who] = recent
        if len(_hits) > 5000:  # forget idle devices
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > 60]:
                _hits.pop(k, None)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # <-- Make sure this is exactly ["*"]
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

@app.get("/api/health")
def health():
    clf: DinoV2PillClassifier | None = state["classifier"]
    names: DrugNameLookup | None = state["drug_names"]
    return {
        "status": "ok" if clf is not None else "loading",
        "model_loaded": clf is not None,
        "device": str(clf.device) if clf is not None else None,
        "num_reference_pills": clf.num_reference_pills if clf is not None else None,
        "num_drug_names": names.size if names is not None else None,
    }


# thumbnails_dir layout (scripts/collect_thumbnails.py): pill/ holds real
# C3PI pill photos, package/ the best DailyMed image (almost always
# package/label art). Files directly in thumbnails_dir are from an older
# run of the script, which was DailyMed-only, so they count as package art.
_THUMB_SUBDIRS = {"pill": "pill", "label_pill": "label_pill", "dm_pill": "dm_pill", "package": "package", "legacy": ""}


def _epillid_photo_rank(zip_path: str) -> int:
    """Lower = cleaner photo: NIH reference shots, then ePillID's other
    reference crops, then consumer (phone) photos."""
    if "/segmented_nih_pills_224/" in zip_path:
        return 0
    if "/dr_224/" in zip_path:
        return 1
    return 2


def _thumbnail_file(label: str, kind: str):
    return get_settings().thumbnails_dir / _THUMB_SUBDIRS[kind] / f"{label}.jpg"


def _resolve_thumbnail(label: str) -> tuple[str | None, str | None]:
    """(url, kind) -- kind is "pill_photo" (a real photo of the pill) or
    "package" (package/label art, labeled as such in the app). Looks across
    every listing of the same physical pill (pill_groups.py):
      1. this label's own C3PI studio photo;
      2. the clearest real photo of the pill from any of its listings
         (C3PI, then ePillID NIH reference shots, then phone photos);
      3. this label's package image, else any listing's."""
    if _thumbnail_file(label, "pill").exists():
        return f"/api/thumbnail?label={quote(label)}&kind=pill", "pill_photo"
    names: DrugNameLookup | None = state.get("drug_names")
    g = names.groups.group_of.get(label) if names is not None and names.groups is not None else None
    photo = state.get("photo_by_group", {}).get(g) if g is not None else None
    if photo is None and label in state.get("epillid_by_label", {}):
        photo = ("zip", state["epillid_by_label"][label])  # no grouping attached (tests)
    if photo is not None:
        how, value = photo
        if how == "zip":
            return f"/api/reference-image?path={quote(value)}", "pill_photo"
        if how in ("label_pill", "dm_pill"):
            return f"/api/thumbnail?label={quote(value)}&kind={how}", "pill_photo"
        if how == "confirmed":
            return f"/api/confirmed-photo?id={quote(value)}", "pill_photo"
        if how == "contrib":
            return f"/api/confirmed-photo?id={quote(value)}&shared=1", "pill_photo"
        return f"/api/thumbnail?label={quote(value)}&kind=pill", "pill_photo"
    for kind in ("package", "legacy"):
        if _thumbnail_file(label, kind).exists():
            return f"/api/thumbnail?label={quote(label)}&kind={kind}", "package"
    pkg = state.get("package_by_group", {}).get(g) if g is not None else None
    if pkg is not None:
        return f"/api/thumbnail?label={quote(pkg[1])}&kind={pkg[0]}", "package"
    return None, None


async def _read_image(file: UploadFile) -> Image.Image:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 15 MB).")
    try:
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="Could not read image. Upload a JPG or PNG.")


@dataclass
class Identification:
    query_embs: "torch.Tensor"
    ranked: list  # (Prediction, info, ImprintMatch, fused_score), one row per physical pill, best first
    imprint_text: str | None
    imprint_source: str | None  # "user", "ocr" or None
    imprint_found: bool | None  # user imprint only: does any candidate carry it exactly?
    low_confidence: bool


def identify(clf: DinoV2PillClassifier, drug_names: DrugNameLookup, images: list[Image.Image],
             imprint: str | None = None, imprint_confirmed: bool = False,
             rx_or_otc: str | None = None, query_embs=None,
             colors: list[str] | None = None, shape: str | None = None) -> Identification:
    """The whole identification pipeline, shared by /api/predict and
    scripts/eval_real_photos.py so the evaluation measures exactly what the
    app does.

    Visual retrieval over the gallery (front/back averaged), then imprint
    fusion: a user-confirmed imprint is trusted (weighted heavily, and its
    exact matches are added even if the visual search missed them); without
    one, OCR on the photos gives a weak signal; a confirmed "no imprint"
    uses none. Duplicate listings of one physical pill collapse to one row.

    colors/shape the user confirmed work the same way, more gently: pills
    whose FDA color and shape agree are added as candidates (best visual
    score first) and get a small bonus; nothing is ruled out, since a
    confirmed color can still be wrong under odd lighting."""
    settings = get_settings()
    if query_embs is None:  # callers may pass embed_images(images) they already computed
        query_embs = clf.embed_images(images)
    pool = clf.predict_topk_from_embeddings(query_embs, k=settings.rerank_pool_size, rx_or_otc=rx_or_otc)

    if imprint_confirmed and not (imprint or "").strip():
        # The user confirmed the pill has no imprint: don't let OCR misreads
        # of a blank pill steer the match.
        text, source, weight = None, None, 0.0
    elif imprint and imprint.strip():
        text, source, weight = imprint.strip(), "user", settings.confirmed_imprint_fusion_weight
        in_pool = {p.label for p in pool}
        extra = [
            label for label, _, _ in drug_names.search_by_appearance(
                imprint=text, color=" ".join(colors or []) or None, shape=shape,
                limit=settings.imprint_candidate_count)
            if label not in in_pool
        ]
        pool = pool + clf.predictions_for_labels(query_embs, extra)
    else:
        # OCR both sides and pool the tokens; imprints are often split
        # across the two faces.
        reads = [t for t in (read_imprint_text(img, drug_names.imprint_vocab) for img in images) if t]
        text = " ".join(reads) if reads else None
        source, weight = ("ocr" if text else None), settings.imprint_fusion_weight

    if colors or shape:
        in_pool = {p.label for p in pool}
        alike = [l for l in drug_names.labels_matching_appearance(clf.label_strings, colors, shape) if l not in in_pool]
        pool = pool + clf.predictions_for_labels(query_embs, alike, top=settings.appearance_candidate_count)

    rows = []
    for p in pool:
        # The predicted label is the primary key; ePillID labels (content
        # hashes) fall back to the NDC in their image filename.
        info = drug_names.display_info(p.label, p.ref_path)
        match = score_imprint_match(text, info.get("imprint") if info else None)
        fused = p.score + weight * match.score
        if colors:  # unknown on record counts half
            ca = color_agreement(colors, info.get("color") if info else None)
            fused += settings.confirmed_color_weight * (0.5 if ca is None else ca)
        if shape:
            sa = shape_agreement(shape, info.get("shape") if info else None)
            fused += settings.confirmed_shape_weight * (0.5 if sa is None else sa)
        rows.append((p, info, match, fused))
    rows.sort(key=lambda row: row[3], reverse=True)
    ranked = dedupe_pills(rows, key=lambda row: drug_names.dedupe_key(row[0].label, row[1]))
    # A result with no drug name and no NDC tells the user nothing; don't let
    # it take a slot. (scripts/fill_missing_drug_info.py names most of them.)
    ranked = [r for r in ranked if r[1] or display_ndc(r[0].label) or display_ndc(ndc_from_ref_path(r[0].ref_path))]

    exact = [r for r in ranked if r[2].score >= 0.99]
    imprint_found = bool(exact) if source == "user" else None
    # Low confidence = the photo doesn't clearly match anything AND the top
    # result isn't backed by an exact confirmed imprint. (The fused score
    # can't be used: a typed imprint adds up to 1.0 to it.)
    top = ranked[0] if ranked else None
    imprint_backed = top is not None and source == "user" and top[2].score >= 0.99
    low_confidence = top is None or (not imprint_backed and top[0].score < settings.low_confidence_threshold)
    # A blank / featureless photo (lens covered, all background) can still
    # produce "matches"; never present those as confident.
    if float(np.asarray(images[0].convert("L").resize((64, 64)), dtype=np.float32).std()) < 4:
        low_confidence = True
    return Identification(query_embs, ranked, text, source, imprint_found, low_confidence)


@app.post("/api/predict")
async def predict(
    response: Response,
    file: UploadFile = File(None),
    file_back: UploadFile = File(None),
    rx_or_otc: str | None = Form(None),  # "RX" | "OTC" | None/omitted == "don't know"
    imprint: str | None = Form(None, max_length=_MAX_IMPRINT),  # imprint the user typed/confirmed, e.g. "L 5"
    # True when the user went through the imprint step. With no imprint it
    # means "this pill has no letters/numbers" (an empty form field arrives
    # as None, so emptiness alone can't say that).
    imprint_confirmed: bool = Form(False),
    colors: str | None = Form(None, max_length=60),  # colors the user confirmed, e.g. "RED,BLUE"
    shape: str | None = Form(None, max_length=30),  # shape the user confirmed, e.g. "CAPSULE"
):  # file = front/primary side (required); file_back = optional reverse side.
    # Set the bypass cookie to destroy the localtunnel landing wall permanently
    response.set_cookie(key="bypass-tunnel-reminder", value="true", path="/")

    if file is None:
        raise HTTPException(status_code=400, detail="No file field provided in form data.")

    clf: DinoV2PillClassifier | None = state["classifier"]
    if clf is None:
        raise HTTPException(status_code=503, detail="Model is still loading; try again shortly.")

    image = await _read_image(file)
    back_image = await _read_image(file_back) if file_back is not None else None

    settings = get_settings()
    drug_names: DrugNameLookup = state["drug_names"]

    images = [image, back_image] if back_image is not None else [image]
    # Only real FDA color/shape words count; anything else is ignored.
    color_list = [c for c in dict.fromkeys(c.strip().upper() for c in (colors or "").split(","))
                  if c in FDA_COLORS][:2] or None
    shape_word = (shape or "").strip().upper()
    ident = identify(clf, drug_names, images, imprint=imprint,
                     imprint_confirmed=imprint_confirmed, rx_or_otc=rx_or_otc,
                     colors=color_list, shape=shape_word if shape_word in FDA_SHAPES else None)
    fused = ident.ranked[: settings.top_k]
    query_embs, ocr_text, imprint_source = ident.query_embs, ident.imprint_text, ident.imprint_source

    results = []
    for p, info, match, fused_score in fused:
        ref_url, ref_kind = _resolve_thumbnail(p.label)
        results.append(
            {
                "label": p.label,
                # p.label is already the canonical representative NDC9 for
                # this pooled group (see drug_names.py's module docstring) --
                # use it directly rather than re-parsing one specific
                # reference image's filename, which breaks for sources whose
                # files aren't NDC-named (e.g. ePillID's "consumer" photo
                # subset uses content-hash filenames, so the old fallback
                # would show a hash like "97121f6cbb03..." as the "NDC" even
                # when the real name/imprint/color lookup above succeeded
                # fine via the label).
                # ePillID labels are content hashes; their image filenames
                # carry the real NDC.
                "ndc": display_ndc(p.label) or display_ndc(ndc_from_ref_path(p.ref_path)),
                "name": info.get("name") if info else None,
                "also_sold_as": drug_names.also_sold_as(p.label, info),
                "imprint": info.get("imprint") if info else None,
                "color": info.get("color") if info else None,
                "shape": info.get("shape") if info else None,
                "score_marks": info.get("score_marks") if info else None,
                "status": info.get("status") if info else None,
                "score": round(p.score, 4),
                "score_pct": round(max(0.0, p.score) * 100, 1),
                "imprint_match_score": round(match.score, 4),
                "fused_score": round(fused_score, 4),
                "reference_image_url": ref_url,
                "reference_image_kind": ref_kind,
            }
        )

    prediction_id = uuid.uuid4().hex
    state.setdefault("_recent_predictions", {})[prediction_id] = {
        "image_bytes": None,  # filled in below, kept out of the JSON response
    }
    # Stash the raw bytes briefly so /api/feedback can save the actual photo
    # without the client re-uploading it. Small in-memory cache, not a queue --
    # fine for beta traffic volumes; revisit if this becomes a real bottleneck.
    file.file.seek(0)
    state["_recent_predictions"][prediction_id]["image_bytes"] = await file.read()
    _prune_recent_predictions()

    return {
        "prediction_id": prediction_id,
        "predictions": results,
        "ocr_imprint_read": ocr_text,
        "imprint_source": imprint_source,  # "user" (typed/confirmed), "ocr", or None
        "low_confidence": ident.low_confidence,
        # False when the user gave an imprint that no pill in the database
        # carries (likely a typo) -- the UI says so instead of silently
        # showing photo-only matches.
        "imprint_found": ident.imprint_found,
        "search_mode": "restricted" if clf.has_restricted_mode(rx_or_otc) else "unrestricted",
        # Front (and back, if sent) embeddings: the client stores these with a
        # pill the user saves to "My Pills" and compares future scans against
        # them on-device -- the user's own photo of their own pill is a far
        # closer reference than the gallery, which for most drugs only has
        # package art.
        "query_embeddings": _embeddings_json(query_embs),
        "query_cohort": _cohort_json(clf, query_embs),
    }


def _embeddings_json(embs) -> list[list[float]]:
    return [[round(v, 5) for v in row] for row in embs.cpu().tolist()]


def _cohort_json(clf: DinoV2PillClassifier, embs) -> list[list[float]]:
    """[mean, std] per embedding of its similarity to other pills in the
    catalog -- lets the app normalize My Pills scores (classifier.cohort_stats)."""
    return [[round(v, 5) for v in row] for row in clf.cohort_stats(embs).tolist()]


@app.post("/api/read-imprint")
async def read_imprint(file: UploadFile = File(...), file_back: UploadFile = File(None)):
    """Suggest the imprint on each side, for the user to confirm or correct
    before matching. Vision model when configured, else Tesseract."""
    images = [await _read_image(file)]
    if file_back is not None:
        images.append(await _read_image(file_back))
    sides = read_imprint_with_vision(images, get_settings().imprint_vision_model)
    source = "vision"
    if sides is None:
        vocab = state["drug_names"].imprint_vocab
        reads = [read_imprint_text(img, vocab) or "" for img in images]
        sides = (reads[0], reads[1] if len(reads) > 1 else "")
        source = "ocr"
    # Color and shape read from the pixels (front photo), as suggestions.
    features = None
    try:
        features = analyze_pill(images[0])
    except Exception as e:  # never block the imprint step on this
        print(f"[read-imprint] color/shape reading failed: {e!r}")
    return {"side_1": sides[0], "side_2": sides[1], "source": source,
            "colors": features.colors if features else [],
            "shape": features.shape if features else None}


@app.post("/api/embed")
async def embed(file: UploadFile = File(...), file_back: UploadFile = File(None)):
    """Embeddings for a saved "My Pills" photo that doesn't have them yet
    (saved before matching against My Pills existed)."""
    clf: DinoV2PillClassifier | None = state["classifier"]
    if clf is None:
        raise HTTPException(status_code=503, detail="Model is still loading; try again shortly.")
    images = [await _read_image(file)]
    if file_back is not None:
        images.append(await _read_image(file_back))
    embs = clf.embed_images(images)
    return {"embeddings": _embeddings_json(embs), "cohort": _cohort_json(clf, embs)}


class _CohortRequest(BaseModel):
    embeddings: list[list[float]]


@app.post("/api/cohort")
def cohort(req: _CohortRequest):
    """Cohort statistics for embeddings the app already has (pills saved
    before the app used them) -- no photo needed."""
    clf: DinoV2PillClassifier | None = state["classifier"]
    if clf is None:
        raise HTTPException(status_code=503, detail="Model is still loading; try again shortly.")
    if not 1 <= len(req.embeddings) <= 64 or any(len(e) != clf.ref_embeddings.shape[1] for e in req.embeddings):
        raise HTTPException(status_code=400, detail="Bad embeddings.")
    return {"cohort": _cohort_json(clf, torch.tensor(req.embeddings, dtype=torch.float32))}


_RECENT_PREDICTIONS_MAX = 200


def _prune_recent_predictions():
    cache = state.get("_recent_predictions", {})
    if len(cache) > _RECENT_PREDICTIONS_MAX:
        for key in list(cache.keys())[: len(cache) - _RECENT_PREDICTIONS_MAX]:
            cache.pop(key, None)


@app.post("/api/feedback")
async def feedback(
    prediction_id: str = Form(...),
    correct: bool = Form(...),
    reported_label: str | None = Form(None),  # optional: what the user says it actually is
    notes: str | None = Form(None),
):
    """'None of these were right' (and 'this one was right') feedback, tied to
    the actual photo. This is the beta's only source of real consumer-domain
    (phone-photo) data -- the training gate has never had any (every number
    so far comes from the same curated-source distribution as training; see
    GATE INCONCLUSIVE in pill-scanner's eval/evaluate.py). Not wired into
    retraining automatically; just accumulates on disk for a future labeling
    + gate-validation pass."""
    cache = state.get("_recent_predictions", {})
    entry = cache.get(prediction_id)
    if entry is None or entry.get("image_bytes") is None:
        raise HTTPException(status_code=404, detail="Unknown or expired prediction_id.")

    settings = get_settings()
    record_id = f"{int(time.time())}_{prediction_id}"
    image_path = settings.feedback_dir / f"{record_id}.jpg"
    meta_path = settings.feedback_dir / f"{record_id}.json"
    image_path.write_bytes(entry["image_bytes"])
    meta_path.write_text(json.dumps({
        "prediction_id": prediction_id,
        "correct": correct,
        "reported_label": reported_label,
        "notes": notes,
        "timestamp": time.time(),
    }, indent=2))
    # A confirmed photo becomes the pill's thumbnail right away if the pill
    # has no real photo yet.
    names: DrugNameLookup | None = state.get("drug_names")
    photos = state.setdefault("photo_by_group", {})
    by_scan = state.setdefault("confirmed_by_scan", {})
    # A changed answer for the same scan withdraws the earlier photo.
    previous = by_scan.pop(prediction_id, None)
    if previous and photos.get(previous[0]) == ("confirmed", previous[1]):
        del photos[previous[0]]
    if correct and reported_label and names is not None and names.groups is not None:
        g = names.groups.group_of.get(reported_label)
        if g is not None and g not in photos:
            photos[g] = ("confirmed", record_id)
            by_scan[prediction_id] = (g, record_id)
    return {"status": "recorded"}


@app.post("/api/contribute")
async def contribute(
    file: UploadFile = File(...),
    file_back: UploadFile = File(None),
    label: str = Form(..., max_length=80),
):
    """A pill photo someone chose to share while setting up a medicine
    (the medicine they picked from the catalog; no names or other info).
    It is checked against the FDA record for that pill (color, shape, a
    clean pill outline -- pill_features.judge_pill_photo) AND the model must
    rank that pill among its top matches for the photo; if both pass, it
    joins the reference gallery and becomes the pill's thumbnail for
    everyone right away. Otherwise it is kept for review only."""
    clf: DinoV2PillClassifier | None = state["classifier"]
    names: DrugNameLookup | None = state.get("drug_names")
    if clf is None or names is None:
        raise HTTPException(status_code=503, detail="Model is still loading; try again shortly.")
    if not _LABEL_RE.match(label) or label not in _known_labels(clf):
        raise HTTPException(status_code=400, detail="Unknown pill.")
    front = await _read_image(file)
    images = [front] + ([await _read_image(file_back)] if file_back is not None else [])
    info = names.display_info(label)
    ok, reason = judge_pill_photo(front, info.get("color") if info else None, info.get("shape") if info else None)
    emb = clf.embed_images(images)
    if ok:
        # The model must agree too: this pill (any listing of it) among its top
        # matches for the photo. Color/shape alone can't tell two white round
        # pills apart, and one mislabeled photo would mislead everyone.
        top = clf.predict_topk_from_embeddings(emb, k=_CONTRIB_AGREE_TOPK)
        g = names.groups.group_of.get(label) if names.groups is not None else None
        agree = any(p.label == label or (g is not None and names.groups.group_of.get(p.label) == g) for p in top)
        if not agree:
            ok, reason = False, f"the model doesn't place this pill in its top {_CONTRIB_AGREE_TOPK} for the photo (kept for review)"
    settings = get_settings()
    settings.contributions_dir.mkdir(parents=True, exist_ok=True)
    record_id = f"{int(time.time())}_{uuid.uuid4().hex}"
    base = settings.contributions_dir / record_id
    front.save(base.with_suffix(".jpg"), "JPEG", quality=90)
    np.save(base.with_suffix(".npy"), emb.cpu().numpy())
    base.with_suffix(".json").write_text(json.dumps({
        "label": label, "accepted": ok, "reason": reason, "timestamp": time.time(),
        "model_signature": model_signature(clf),
    }, indent=2))
    if ok:
        clf.add_to_gallery(emb, [label] * len(images), [f"contrib/{record_id}.jpg"] * len(images))
        g = names.groups.group_of.get(label) if names.groups is not None else None
        photos = state.setdefault("photo_by_group", {})
        if g is not None and g not in photos:
            photos[g] = ("contrib", record_id)
    return {"accepted": ok, "reason": reason}


_CONTRIB_AGREE_TOPK = 30


def _known_labels(clf: DinoV2PillClassifier) -> set[str]:
    if "_known_labels" not in state:
        state["_known_labels"] = {str(l) for l in clf.label_strings}
    return state["_known_labels"]


@app.get("/api/confirmed-photo")
def confirmed_photo(id: str = Query(...), shared: bool = Query(False)):
    """A user-confirmed scan photo (or a shared setup photo) used as a pill's thumbnail."""
    if not _RECORD_RE.match(id):
        raise HTTPException(status_code=400, detail="Invalid id.")
    settings = get_settings()
    path = (settings.contributions_dir if shared else settings.feedback_dir) / f"{id}.jpg"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Photo not found.")
    return Response(content=path.read_bytes(), media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=86400"})

@app.get("/api/reference-image")
def reference_image(path: str = Query(..., description="Zip member path under ePillID_data/")):
    ref_store: ReferenceImageStore | None = state["ref_store"]
    if ref_store is None:
        raise HTTPException(status_code=503, detail="Reference store not ready.")
    result = ref_store.read(path)
    if result is None:
        raise HTTPException(status_code=404, detail="Reference image not found.")
    data, content_type = result
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


_LABEL_RE = re.compile(r"^[A-Za-z0-9._-]+$")


@app.get("/api/thumbnail")
def thumbnail(
    label: str = Query(..., description="Pill label (NDC9-style)"),
    kind: str = Query("legacy", description='"pill", "package", or "legacy" (flat folder)'),
):
    """Serves thumbnails_dir/[pill|package/]{label}.jpg -- see
    _resolve_thumbnail and scripts/collect_thumbnails.py."""
    if not _LABEL_RE.match(label) or kind not in _THUMB_SUBDIRS:
        raise HTTPException(status_code=400, detail="Invalid label.")
    path = _thumbnail_file(label, kind)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found.")
    return Response(
        content=path.read_bytes(),
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )

def _build_search_result(label: str, info: dict) -> dict:
    ref_url, ref_kind = _resolve_thumbnail(label)
    return {
        "label": label,
        "ndc": display_ndc(label),
        "name": info.get("name"),
        "also_sold_as": state["drug_names"].also_sold_as(label, info),
        "imprint": info.get("imprint"),
        "color": info.get("color"),
        "shape": info.get("shape"),
        "score_marks": info.get("score_marks"),
        "reference_image_url": ref_url,
        "reference_image_kind": ref_kind,
    }


@app.get("/api/search-by-name")
def search_by_name(
    q: str = Query(..., min_length=1, max_length=100),
    imprint: str | None = Query(None, max_length=_MAX_IMPRINT),
    limit: int = Query(30, ge=1, le=50),
):
    """Look a medication up by name instead of a photo -- 'what does X look
    like' rather than 'what is this'. imprint optionally narrows it down."""
    drug_names: DrugNameLookup = state["drug_names"]
    results = drug_names.search_by_name(q, limit=limit, imprint=imprint)
    return {"results": [_build_search_result(label, info) for label, info in results]}


@app.get("/api/search-by-appearance")
def search_by_appearance(
    color: str | None = Query(None, max_length=60),
    shape: str | None = Query(None, max_length=30),
    imprint: str | None = Query(None, max_length=_MAX_IMPRINT),
    score_marks: str | None = Query(None, max_length=4),
    limit: int = Query(20, ge=1, le=50),
):
    """Fallback for when the photo-based match misses: describe what the
    pill looks like (color/shape/imprint/score marks) and search the same
    metadata table directly, the way Epocrates' manual identifier works."""
    drug_names: DrugNameLookup = state["drug_names"]
    if not any([color, shape, imprint, score_marks]):
        raise HTTPException(status_code=400, detail="Provide at least one of color/shape/imprint/score_marks.")
    results = drug_names.search_by_appearance(
        color=color, shape=shape, imprint=imprint, score_marks=score_marks, limit=limit
    )
    return {
        "results": [
            {**_build_search_result(label, info), "match_count": count} for label, info, count in results
        ]
    }


# The web app itself, when built (`npm run build:static`): registered last so
# every /api route above wins.
_frontend = get_settings().frontend_dir
if (_frontend / "index.html").exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_frontend, html=True), name="frontend")
    print(f"[startup] Serving the web app from {_frontend}")


if __name__ == "__main__":
    import uvicorn
    # Change it to this:
    uvicorn.run(app, host="127.0.0.1", port=8000)

