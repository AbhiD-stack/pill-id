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
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError

from classifier import DinoV2PillClassifier
from config import get_settings
from drug_names import DrugNameLookup
from imprint_match import read_imprint_text, score_imprint_match
from reference_images import ReferenceImageStore, map_to_zip_path
MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB

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

    print("[startup] Loading model... (first run downloads the DINOv2 backbone)")
    state["classifier"] = DinoV2PillClassifier(
        model_dir=settings.model_artifacts_dir,
        device=settings.device,
        lora_adapter_dir=settings.lora_adapter_dir,
        label_meta_path=settings.label_meta_path,
    )
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
    state["epillid_by_label"] = {}
    if state["ref_store"] is not None:
        clf = state["classifier"]
        label_idx = clf.ref_label_indices.cpu().numpy()
        for i, path in enumerate(clf.ref_abs_paths):
            zp = map_to_zip_path(str(path))
            if zp.startswith("ePillID_data/") and state["ref_store"].has(zp):
                state["epillid_by_label"].setdefault(str(clf.label_strings[label_idx[i]]), zp)
        print(f"[startup] Real ePillID pill photos available for {len(state['epillid_by_label'])} labels.")
    state["drug_names"] = DrugNameLookup()
    settings.feedback_dir.mkdir(parents=True, exist_ok=True)
    print("[startup] Ready.")
    yield
    if state["ref_store"] is not None:
        state["ref_store"].close()


app = FastAPI(title="Pill ID API", version="0.1.0", lifespan=lifespan)


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
_THUMB_SUBDIRS = {"pill": "pill", "package": "package", "legacy": ""}


def _thumbnail_file(label: str, kind: str):
    return get_settings().thumbnails_dir / _THUMB_SUBDIRS[kind] / f"{label}.jpg"


def _resolve_thumbnail(label: str, ref_path: str | None, ref_store: ReferenceImageStore | None
                       ) -> tuple[str | None, str | None]:
    """(url, kind) -- kind is "pill_photo" (a real photo of the pill) or
    "package" (package/label art, which the app replaces with a drawn pill
    illustration when it has the pill's shape/color). Real photos win:
      1. the exact winning reference image, if it's a real ePillID photo;
      2. any real ePillID photo for the label (epillid_by_label);
      3. a C3PI photo from thumbnails/pill/;
      4. DailyMed art from thumbnails/package/ (or the legacy flat folder)."""
    if ref_store is not None and ref_path is not None:
        zip_path = map_to_zip_path(ref_path)
        if zip_path.startswith("ePillID_data/") and ref_store.has(zip_path):
            return f"/api/reference-image?path={quote(zip_path)}", "pill_photo"
    zip_path = state.get("epillid_by_label", {}).get(label)
    if zip_path is not None:
        return f"/api/reference-image?path={quote(zip_path)}", "pill_photo"
    for kind, result_kind in (("pill", "pill_photo"), ("package", "package"), ("legacy", "package")):
        if _thumbnail_file(label, kind).exists():
            return f"/api/thumbnail?label={quote(label)}&kind={kind}", result_kind
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


@app.post("/api/predict")
async def predict(
    response: Response,
    file: UploadFile = File(None),
    file_back: UploadFile = File(None),
    rx_or_otc: str | None = Form(None),  # "RX" | "OTC" | None/omitted == "don't know"
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
    ref_store: ReferenceImageStore | None = state["ref_store"]
    drug_names: DrugNameLookup = state["drug_names"]

    # Pull a wider embedding-only pool (averaged across front+back when both
    # are provided), then re-rank it with the OCR imprint signal so a
    # candidate with a matching imprint but slightly lower raw visual
    # similarity can still surface in the final top_k. rx_or_otc restricts
    # the pool to that category's priority-tier labels (the "ask RX/OTC/
    # don't know" app mode the training gate's 93-98% numbers were measured
    # against) -- omitted/unrecognized falls back to the full unrestricted
    # gallery (~89.5% top10), which is always available.
    images = [image, back_image] if back_image is not None else [image]
    query_embs = clf.embed_images(images)
    pool = clf.predict_topk_from_embeddings(query_embs, k=settings.rerank_pool_size, rx_or_otc=rx_or_otc)

    # Try OCR on both sides and pool the tokens; imprint codes are often split
    # across the front and back faces (e.g. maker mark on one, strength on
    # the other), so a single-side read would miss half the signal.
    ocr_candidates = [t for t in (read_imprint_text(img) for img in images) if t]
    ocr_text = " ".join(ocr_candidates) if ocr_candidates else None

    fused = []
    for p in pool:
        # Prefer lookup by the model's own predicted label -- it's already
        # the canonical pooled identifier for the new gallery, and reliable
        # across every source dataset (filename-based lookup below is not;
        # see drug_names.py). Fall back to the old filename-derived NDC only
        # if the new table has no entry for this label (e.g. an older
        # checkpoint/table pairing).
        info = drug_names.lookup_by_label(p.label) or drug_names.lookup(p.ref_path)
        candidate_imprint = info.get("imprint") if info else None
        match = score_imprint_match(ocr_text, candidate_imprint)
        fused.append((p, info, match, p.score + settings.imprint_fusion_weight * match.score))
    fused.sort(key=lambda row: row[3], reverse=True)
    fused = fused[: settings.top_k]

    results = []
    for p, info, match, fused_score in fused:
        ref_url, ref_kind = _resolve_thumbnail(p.label, p.ref_path, ref_store)
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
                "ndc": p.label,
                "name": info.get("name") if info else None,
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

    top_fused_score = results[0]["fused_score"] if results else 0.0
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
        "low_confidence": top_fused_score < settings.low_confidence_threshold,
        "search_mode": "restricted" if clf.has_restricted_mode(rx_or_otc) else "unrestricted",
        # Front (and back, if sent) embeddings: the client stores these with a
        # pill the user saves to "My Pills" and compares future scans against
        # them on-device -- the user's own photo of their own pill is a far
        # closer reference than the gallery, which for most drugs only has
        # package art.
        "query_embeddings": _embeddings_json(query_embs),
    }


def _embeddings_json(embs) -> list[list[float]]:
    return [[round(v, 5) for v in row] for row in embs.cpu().tolist()]


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
    return {"embeddings": _embeddings_json(clf.embed_images(images))}


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
    return {"status": "recorded"}

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
    clf: DinoV2PillClassifier = state["classifier"]
    ref_store: ReferenceImageStore | None = state["ref_store"]
    ref_path = clf.ref_path_for_label(label)
    ref_url, ref_kind = _resolve_thumbnail(label, ref_path, ref_store)
    return {
        "label": label,
        "ndc": label,
        "name": info.get("name"),
        "imprint": info.get("imprint"),
        "color": info.get("color"),
        "shape": info.get("shape"),
        "score_marks": info.get("score_marks"),
        "reference_image_url": ref_url,
        "reference_image_kind": ref_kind,
    }


@app.get("/api/search-by-name")
def search_by_name(q: str = Query(..., min_length=1), limit: int = Query(20, le=50)):
    """Look a medication up by name instead of a photo -- 'what does X look
    like' rather than 'what is this'."""
    drug_names: DrugNameLookup = state["drug_names"]
    results = drug_names.search_by_name(q, limit=limit)
    return {"results": [_build_search_result(label, info) for label, info in results]}


@app.get("/api/search-by-appearance")
def search_by_appearance(
    color: str | None = Query(None),
    shape: str | None = Query(None),
    imprint: str | None = Query(None),
    score_marks: str | None = Query(None),
    limit: int = Query(20, le=50),
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


if __name__ == "__main__":
    import uvicorn
    # Change it to this:
    uvicorn.run(app, host="127.0.0.1", port=8000)