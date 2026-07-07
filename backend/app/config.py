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

    # Browser origins allowed to call the API (comma-separated in the env var).
    # Localhost for dev; add the Vercel URL when the frontend is deployed.
    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
