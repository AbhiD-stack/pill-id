# Build from the REPO ROOT so the model artifacts at the root are in context
FROM python:3.12-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/hf-cache \
    MODEL_ARTIFACTS_DIR=/artifacts \
    DATASET_ZIP_PATH=/artifacts/ePillID_data.zip \
    DEVICE=cpu

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg62-turbo libpng16-16 && \
    rm -rf /var/lib/apt/lists/*

# Create artifacts directory and set permissions for the non-root user
RUN mkdir -p /artifacts /opt/hf-cache && \
    chown -R 1000:1000 /app /artifacts /opt/hf-cache

# Switch to non-root user for security
USER 1000

# Install Python dependencies
COPY --chown=1000:1000 backend/requirements.txt .
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

# Copy application code and artifacts
COPY --chown=1000:1000 backend/app ./app
COPY --chown=1000:1000 config.json /artifacts/config.json
COPY --chown=1000:1000 dinov2_projection_head /artifacts/dinov2_projection_head
COPY --chown=1000:1000 ePillID_data.zip /artifacts/ePillID_data.zip

# Pre-download the DINOv2-large backbone
RUN python -c "from transformers import AutoModel, AutoImageProcessor; \
    AutoImageProcessor.from_pretrained('facebook/dinov2-large'); \
    AutoModel.from_pretrained('facebook/dinov2-large')"

# Hugging Face requires port 7860
EXPOSE 7860
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]