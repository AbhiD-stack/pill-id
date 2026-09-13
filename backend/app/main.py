"""FastAPI service for pill identification.

Endpoints:
  GET  /api/health              -> service + model status
  POST /api/predict             -> identify a pill from an uploaded image
  GET  /api/reference-image     -> matched reference pill thumbnail (from dataset zip)
  GET  /api/search              -> find medications by name (V3 "My Pills" lookup)
  GET  /api/search-by-attributes -> find medications by shape/color/imprint/score
                                    marks (V3 scan-fallback filters)
  POST /api/ocr-label           -> OCR a bottle-label photo, suggest matching
                                    medications (V3)

The model is loaded once at startup and kept warm in memory. None of these
endpoints persist an uploaded image to disk or a log; each request is
processed in memory and discarded once the response is sent.

/api/search and /api/ocr-label both supplement local reference-gallery
matches with a live DailyMed lookup (dailymed_live.py) when the local
catalog doesn't fill the requested result count -- this is name/text search
only, not photo identification. Photo-based scanning (/api/predict) still
only searches the precomputed embedding gallery; there is no live-DailyMed
equivalent for that, since matching a photo requires an embedding computed
ahead of time (see notebooks/), not something that can be done inside a
single request.
"""
from __future__ import annotations

import io
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, Query, UploadFile, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError

import dailymed_live
import ocr
from catalog import CatalogEntry, MedicationCatalog
from classifier import DinoV2PillClassifier
from config import get_settings
from drug_names import DrugNameLookup, ndc_from_ref_path
from reference_images import ReferenceImageStore, map_to_zip_path
MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB

# Populated in the lifespan handler.
state: dict = {"classifier": None, "ref_store": None, "drug_names": None, "catalog": None}




@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    print("[startup] Loading model... (first run downloads the DINOv2 backbone)")
    state["classifier"] = DinoV2PillClassifier(
        model_dir=settings.model_artifacts_dir, device=settings.device
    )
    state["ref_store"] = ReferenceImageStore({
        "ePillID_data": settings.dataset_zip_path,
        "otc_data": settings.otc_dataset_zip_path,
    })
    state["drug_names"] = DrugNameLookup()
    clf: DinoV2PillClassifier = state["classifier"]
    state["catalog"] = MedicationCatalog(
        label_strings=clf.label_strings,
        ref_abs_paths=clf.ref_abs_paths,
        ref_label_indices=clf.ref_label_indices,
        drug_names=state["drug_names"],
    )
    print(f"[startup] OCR available: {ocr.is_available()}")
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
    catalog: MedicationCatalog | None = state["catalog"]
    return {
        "status": "ok" if clf is not None else "loading",
        "model_loaded": clf is not None,
        "device": str(clf.device) if clf is not None else None,
        "num_reference_pills": clf.num_reference_pills if clf is not None else None,
        "num_drug_names": names.size if names is not None else None,
        "num_catalog_entries": len(catalog.entries) if catalog is not None else None,
        "ocr_available": ocr.is_available(),
    }


def _entry_to_dict(entry: CatalogEntry) -> dict:
    ref_store: ReferenceImageStore = state["ref_store"]
    ref_url = None
    for path in entry.ref_paths:
        zip_path = map_to_zip_path(path)
        if ref_store.has(zip_path):
            ref_url = f"/api/reference-image?path={quote(zip_path)}"
            break
    return {
        "label": entry.label,
        "ndc": entry.ndc,
        "name": entry.name,
        "imprint": entry.imprint,
        "color": entry.color,
        "shape": entry.shape,
        "score_marks": entry.score_marks,
        "status": entry.status,
        "reference_image_url": ref_url,
        "source": "local",
    }


def _augment_with_live_dailymed(results: list[dict], query: str, limit: int) -> list[dict]:
    """Fill remaining slots up to `limit` with live DailyMed name-search
    results, skipping anything that duplicates a name already in `results`.
    Best-effort: any DailyMed failure just means no augmentation, never an
    error surfaced to the caller.

    Requests `limit` (not just the remaining slot count) live results,
    since some of them will typically be dedup'd away as names already
    present locally -- asking for only the exact shortfall would silently
    undershoot `limit` whenever any overlap exists."""
    if len(results) >= limit:
        return results
    seen_names = {(r.get("name") or "").strip().lower() for r in results}
    for live in dailymed_live.search_dailymed_live(query, limit=limit):
        if len(results) >= limit:
            break
        name_key = (live.get("name") or "").strip().lower()
        if name_key in seen_names:
            continue
        seen_names.add(name_key)
        results.append(dict(live))
    return results


@app.post("/api/predict")
async def predict(response: Response, file: UploadFile = File(None)): # <-- Change File(...) to File(None)
    # Set the bypass cookie to destroy the localtunnel landing wall permanently
    response.set_cookie(key="bypass-tunnel-reminder", value="true", path="/")
    
    if file is None:
        raise HTTPException(status_code=400, detail="No file field provided in form data.")
        
    clf: DinoV2PillClassifier | None = state["classifier"]
    # ... rest of your code stays exactly the same ...
    if clf is None:
        raise HTTPException(status_code=503, detail="Model is still loading; try again shortly.")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 15 MB).")

    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="Could not read image. Upload a JPG or PNG.")

    settings = get_settings()
    ref_store: ReferenceImageStore = state["ref_store"]
    drug_names: DrugNameLookup = state["drug_names"]
    predictions = clf.predict_topk(image, k=settings.top_k)

    results = []
    for p in predictions:
        zip_path = map_to_zip_path(p.ref_path)
        ref_url = (
            f"/api/reference-image?path={quote(zip_path)}"
            if ref_store.has(zip_path)
            else None
        )
        info = drug_names.lookup(p.ref_path)
        results.append(
            {
                "label": p.label,
                "ndc": ndc_from_ref_path(p.ref_path),
                "name": info.get("name") if info else None,
                "imprint": info.get("imprint") if info else None,
                "color": info.get("color") if info else None,
                "shape": info.get("shape") if info else None,
                "score_marks": info.get("score") if info else None,
                "status": info.get("status") if info else None,
                "score": round(p.score, 4),
                "score_pct": round(max(0.0, p.score) * 100, 1),
                "reference_image_url": ref_url,
            }
        )

    return {"predictions": results}

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

@app.get("/api/search")
def search_by_name(
    name: str = Query(..., min_length=1, description="Medication name to search for"),
    limit: int = Query(20, ge=1, le=50),
):
    """Look up medications by name -- V3's 'what does my medication currently
    look like' lookup, independent of any photo scan.

    Local reference-gallery matches come first; if there's room left under
    `limit`, live DailyMed results fill the rest so a name search isn't
    capped by whatever happens to be in the local embedding gallery. Live
    results have no local photo/embedding (reference_image_url is always
    null, source is "dailymed_live") -- they're for finding/naming a
    medication, not for the image-similarity scan."""
    catalog: MedicationCatalog | None = state["catalog"]
    if catalog is None:
        raise HTTPException(status_code=503, detail="Catalog still loading; try again shortly.")
    matches = [_entry_to_dict(e) for e in catalog.search_by_name(name, limit=limit)]
    matches = _augment_with_live_dailymed(matches, name, limit)
    return {"matches": matches}


@app.get("/api/search-by-attributes")
def search_by_attributes(
    color: Optional[str] = Query(None),
    shape: Optional[str] = Query(None),
    imprint: Optional[str] = Query(None),
    score_marks: Optional[str] = Query(None, alias="score"),
    limit: int = Query(20, ge=1, le=50),
):
    """Shape/color/imprint/score-mark filter search -- the Epocrates-style
    backup used in V3 when a photo scan doesn't surface the right pill.
    Note: shape/score_marks are only populated for reference pills whose
    ndc_names.json entry was built after that field was added (see
    scripts/build_ndc_names.py) -- older entries just won't match on those
    two filters, not error."""
    catalog: MedicationCatalog | None = state["catalog"]
    if catalog is None:
        raise HTTPException(status_code=503, detail="Catalog still loading; try again shortly.")
    if not any([color, shape, imprint, score_marks]):
        raise HTTPException(status_code=400, detail="Provide at least one of color, shape, imprint, score.")
    matches = catalog.search_by_attributes(
        color=color, shape=shape, imprint=imprint, score_marks=score_marks, limit=limit
    )
    return {"matches": [_entry_to_dict(e) for e in matches]}


@app.post("/api/ocr-label")
async def ocr_label(file: UploadFile = File(...)):
    """OCR a pill-bottle label photo and suggest matching medications.

    Privacy: the uploaded image is decoded in memory, OCR'd, and discarded --
    it is never written to disk or logged, matching /api/predict. This is an
    experimental pilot tool without IRB review; it is not a HIPAA-covered
    entity's system, but bottle-label photos can contain a patient's name and
    other identifying info, so treat this endpoint the same as any other PHI
    handling in your own deployment/hosting choices.
    """
    catalog: MedicationCatalog | None = state["catalog"]
    if catalog is None:
        raise HTTPException(status_code=503, detail="Catalog still loading; try again shortly.")
    if not ocr.is_available():
        raise HTTPException(
            status_code=503,
            detail="OCR isn't installed on this server (tesseract-ocr + pytesseract). "
            "Ask your administrator to install it, or use name search instead.",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 15 MB).")
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="Could not read image. Upload a JPG or PNG.")

    try:
        raw_text = ocr.extract_label_text(image)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    candidates = [_entry_to_dict(e) for e in ocr.suggest_candidates_from_text(raw_text, catalog, limit=10)]
    guess = ocr.top_phrase(raw_text)
    if guess:
        candidates = _augment_with_live_dailymed(candidates, guess, limit=10)
    return {
        "raw_text": raw_text.strip(),
        "candidates": candidates,
    }


if __name__ == "__main__":
    import uvicorn
    # Change it to this:
    uvicorn.run(app, host="127.0.0.1", port=8000)