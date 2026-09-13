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

from fastapi import FastAPI, File, HTTPException, Query, UploadFile, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError

from classifier import DinoV2PillClassifier
from config import get_settings
from drug_names import DrugNameLookup, ndc_from_ref_path
from imprint_match import read_imprint_text, score_imprint_match
from reference_images import ReferenceImageStore, map_to_zip_path
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
    ref_store: ReferenceImageStore = state["ref_store"]
    drug_names: DrugNameLookup = state["drug_names"]

    # Pull a wider embedding-only pool (averaged across front+back when both
    # are provided), then re-rank it with the OCR imprint signal so a
    # candidate with a matching imprint but slightly lower raw visual
    # similarity can still surface in the final top_k.
    images = [image, back_image] if back_image is not None else [image]
    pool = clf.predict_topk_multi(images, k=settings.rerank_pool_size)

    # Try OCR on both sides and pool the tokens; imprint codes are often split
    # across the front and back faces (e.g. maker mark on one, strength on
    # the other), so a single-side read would miss half the signal.
    ocr_candidates = [t for t in (read_imprint_text(img) for img in images) if t]
    ocr_text = " ".join(ocr_candidates) if ocr_candidates else None

    fused = []
    for p in pool:
        info = drug_names.lookup(p.ref_path)
        candidate_imprint = info.get("imprint") if info else None
        match = score_imprint_match(ocr_text, candidate_imprint)
        fused.append((p, info, match, p.score + settings.imprint_fusion_weight * match.score))
    fused.sort(key=lambda row: row[3], reverse=True)
    fused = fused[: settings.top_k]

    results = []
    for p, info, match, fused_score in fused:
        zip_path = map_to_zip_path(p.ref_path)
        ref_url = (
            f"/api/reference-image?path={quote(zip_path)}"
            if ref_store.has(zip_path)
            else None
        )
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
                "imprint_match_score": round(match.score, 4),
                "fused_score": round(fused_score, 4),
                "reference_image_url": ref_url,
            }
        )

    top_fused_score = results[0]["fused_score"] if results else 0.0
    return {
        "predictions": results,
        "ocr_imprint_read": ocr_text,
        "low_confidence": top_fused_score < settings.low_confidence_threshold,
    }

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

if __name__ == "__main__":
    import uvicorn
    # Change it to this:
    uvicorn.run(app, host="127.0.0.1", port=8000)