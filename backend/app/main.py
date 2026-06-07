"""FastAPI service for pill identification.

Endpoints:
  GET  /api/health            -> service + model status
  POST /api/predict           -> identify a pill from an uploaded image
  GET  /api/reference-image   -> matched reference pill thumbnail (from dataset zip)

The model is loaded once at startup and kept warm in memory.
"""
from __future__ import annotations

import io
from contextlib import asynccontextmanager
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError

from .classifier import DinoV2PillClassifier
from .config import get_settings
from .drug_names import DrugNameLookup, ndc_from_ref_path
from .reference_images import ReferenceImageStore, map_to_zip_path

MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB

# Populated in the lifespan handler.
state: dict = {"classifier": None, "ref_store": None, "drug_names": None}


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    print("[startup] Loading model... (first run downloads the DINOv2 backbone)")
    state["classifier"] = DinoV2PillClassifier(
        model_dir=settings.model_artifacts_dir, device=settings.device
    )
    state["ref_store"] = ReferenceImageStore(settings.dataset_zip_path)
    state["drug_names"] = DrugNameLookup()
    print("[startup] Ready.")
    yield
    if state["ref_store"] is not None:
        state["ref_store"].close()


app = FastAPI(title="Pill ID API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
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


@app.post("/api/predict")
async def predict(file: UploadFile = File(...)):
    clf: DinoV2PillClassifier | None = state["classifier"]
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
