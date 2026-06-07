# Build from the REPO ROOT so the model artifacts at the root are in context:
#   docker build -f backend/Dockerfile -t pill-id-backend .
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/hf-cache

WORKDIR /app

# System libs needed by Pillow / torchvision image decoding.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg62-turbo libpng16-16 && \
    rm -rf /var/lib/apt/lists/*

# Install Python deps first (cached layer). CPU-only torch keeps the image small;
# swap the index URL for a CUDA build if deploying to a GPU instance.
COPY backend/requirements.txt .
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

# Application code.
COPY backend/app ./app

# Model artifacts + dataset (large). Baking them in makes Spot restarts fast
# (no re-download). For a slimmer image, mount these as a volume instead and set
# MODEL_ARTIFACTS_DIR / DATASET_ZIP_PATH accordingly.
COPY config.json /artifacts/config.json
COPY dinov2_projection_head /artifacts/dinov2_projection_head
COPY ePillID_data.zip /artifacts/ePillID_data.zip

ENV MODEL_ARTIFACTS_DIR=/artifacts \
    DATASET_ZIP_PATH=/artifacts/ePillID_data.zip \
    DEVICE=cpu

# Pre-download the DINOv2-large backbone into the image so cold starts (and Spot
# instance replacements) don't wait on HuggingFace. Comment out to fetch lazily.
RUN python -c "from transformers import AutoModel, AutoImageProcessor; \
    AutoImageProcessor.from_pretrained('facebook/dinov2-large'); \
    AutoModel.from_pretrained('facebook/dinov2-large')"

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
