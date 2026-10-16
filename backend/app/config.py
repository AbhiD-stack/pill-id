"""Application configuration.

Values are read from environment variables (or a local .env file) so the same
code runs unchanged on a laptop and on the EC2 host. See .env.example.
"""
from functools import lru_cache
from pathlib import Path
from typing import Optional

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

    # LoRA adapter directory (dinov2_projection_head/lora_adapter), saved by the
    # pill-scanner training run's finetune_with_lora phase. The reference
    # gallery embeddings (deployed_ref_embeddings.pt) were computed AFTER this
    # adapter was applied to the backbone, so serving must apply the same
    # adapter before embedding a query image -- otherwise query and gallery
    # embeddings come from two different backbones and similarity scores are
    # silently wrong. None = no adapter (frozen base backbone only, matching
    # the old pre-LoRA checkpoints).
    lora_adapter_dir: Optional[Path] = None

    # label -> {"category": "RX"|"OTC"|"unknown", "tier": "priority"|"long_tail"|"unknown"}.
    # Built from the training run's image_manifest.csv (scripts/build_label_metadata.py).
    # Required for the restricted-gallery search mode (ask RX/OTC/don't know),
    # which is what the training gate's actual headline numbers (93-98% vs the
    # 89.5% unrestricted figure) are measured against.
    label_meta_path: Path = Path(__file__).resolve().parent / "data" / "label_meta.json"

    # The ePillID dataset zip used to display matched reference pill images.
    # Only covers ePillID-sourced matches (~3% of the gallery) -- checked as
    # a fallback after thumbnails_dir below, which covers the much larger
    # DailyMed-sourced slice of the priority tier.
    dataset_zip_path: Path = REPO_ROOT / "ePillID_data.zip"

    # label -> {label}.jpg, one representative thumbnail per label (built by
    # scripts/collect_thumbnails.py from the DailyMed acquisition output,
    # covering priority-tier labels -- the ones restricted search actually
    # returns). Checked before falling back to dataset_zip_path above.
    thumbnails_dir: Path = Path(__file__).resolve().parent / "data" / "thumbnails"
    # Real pill photos from drug labels, embedded with the model and added
    # to the reference gallery at startup (scripts/build_photo_gallery.py).
    photo_gallery_path: Path = Path(__file__).resolve().parent / "data" / "photo_gallery.pt"
    # The built web app (`npm run build:static` in frontend/). When present,
    # the backend serves it too, so the whole app runs from one address.
    frontend_dir: Path = REPO_ROOT / "frontend" / "out"
    # Scans/OCR requests per minute from one device (a public link must not
    # let one client tie up the model for everyone).
    rate_limit_per_minute: int = 40

    # "auto" -> cuda if available, else mps (Apple Silicon), else cpu.
    # Override with "cpu" / "mps" / "cuda" if needed.
    device: str = "auto"

    # How many candidate matches to return per prediction.
    top_k: int = 10

    # How many embedding-only candidates to pull before imprint re-ranking.
    # Must be >= top_k; wider pool gives the re-ranker room to promote a
    # correct-but-not-top-embedding-score candidate. Also absorbs duplicate
    # listings of the same pill, which are collapsed before taking top_k.
    rerank_pool_size: int = 60

    # Weight of the OCR imprint-match score in the final fused score. The
    # fused score is: cosine_similarity + imprint_fusion_weight * imprint_score
    # (imprint_score in [0, 1]), so this is roughly "how many points of cosine
    # similarity a perfect imprint match is worth."
    imprint_fusion_weight: float = 0.25

    # Same, for an imprint the user typed or confirmed. A human-checked
    # imprint is far more reliable than raw OCR, so it outweighs visual
    # similarity: an exact imprint match (score 1.0) beats a merely
    # similar-looking pill with a different imprint, since cosine scores
    # between candidates rarely differ by more than ~0.4.
    confirmed_imprint_fusion_weight: float = 1.0

    # With an imprint, this many imprint-search hits are added to the
    # candidates even if the visual search missed them (e.g. drugs whose
    # only reference images are package art).
    imprint_candidate_count: int = 30
    # A color/shape the user confirmed (suggested from the photo by
    # pill_features.py): pills whose FDA record agrees are added as candidates
    # and get a small bonus. Small on purpose -- a confirmed imprint is near-
    # decisive (1.0), color/shape only nudge (lighting can fool both the
    # reader and the user). Check with scripts/eval_real_photos.py.
    appearance_candidate_count: int = 30
    confirmed_color_weight: float = 0.15
    confirmed_shape_weight: float = 0.08

    # Model that reads the imprint from the photo (imprint_vision.py) when
    # ANTHROPIC_API_KEY is set. claude-haiku-5-5 is much cheaper per scan.
    imprint_vision_model: str = "claude-opus-5-5"

    # Below this fused top-1 score, flag the response as low-confidence
    # instead of presenting a guess as if it were reliable.
    low_confidence_threshold: float = 0.45

    # Browser origins allowed to call the API (comma-separated in the env var).
    # Localhost for dev; add the Vercel URL when the frontend is deployed.
    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    # Where "none of these are right" feedback (photo + context) gets written.
    # This is the beta's only source of real consumer-domain (phone-photo)
    # data -- the training gate has never had any (see eval/evaluate.py's
    # GATE INCONCLUSIVE message in pill-scanner). Not wired into training
    # automatically; just accumulates for a future labeling pass.
    feedback_dir: Path = REPO_ROOT / "feedback"


@lru_cache
def get_settings() -> Settings:
    return Settings()
