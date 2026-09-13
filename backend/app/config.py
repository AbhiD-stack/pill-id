"""Application configuration.

Values are read from environment variables (or a local .env file) so the same
code runs unchanged on a laptop and on the EC2 host. See .env.example.
"""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo root = two levels up from this file (backend/app/config.py -> repo root).
# The trained model artifacts (config.json, dinov2_projection_head/, the dataset
# zip) currently live at the repo root, so that is the default location.
REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Where config.json + the dinov2_projection_head/ folder live.
    model_artifacts_dir: Path = REPO_ROOT

    # The ePillID dataset zip used to display matched reference pill images.
    dataset_zip_path: Path = REPO_ROOT / "ePillID_data.zip"

    # "auto" -> cuda if available, else mps (Apple Silicon), else cpu.
    # Override with "cpu" / "mps" / "cuda" if needed.
    device: str = "auto"

    # How many candidate matches to return per prediction.
    top_k: int = 10

    # How many embedding-only candidates to pull before imprint re-ranking.
    # Must be >= top_k; wider pool gives the re-ranker room to promote a
    # correct-but-not-top-embedding-score candidate.
    rerank_pool_size: int = 30

    # Weight of the OCR imprint-match score in the final fused score. The
    # fused score is: cosine_similarity + imprint_fusion_weight * imprint_score
    # (imprint_score in [0, 1]), so this is roughly "how many points of cosine
    # similarity a perfect imprint match is worth."
    imprint_fusion_weight: float = 0.25

    # Below this fused top-1 score, flag the response as low-confidence
    # instead of presenting a guess as if it were reliable.
    low_confidence_threshold: float = 0.45

    # Browser origins allowed to call the API (comma-separated in the env var).
    # Localhost for dev; add the Vercel URL when the frontend is deployed.
    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
