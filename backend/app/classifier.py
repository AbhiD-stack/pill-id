"""DINOv2 + projection-head pill classifier.

Retrieval-based: a frozen DINOv2-large backbone extracts features, a trained
projection head maps them to a 512-d embedding, and the query embedding is
compared (cosine similarity) against a gallery of reference pill embeddings.
The top-k pill labels (NDC codes) are returned with their best-matching
reference image path.

Refactored from the original deploy_model.py for use as a long-lived,
warm-in-memory service (loaded once at process startup).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image
from transformers import AutoImageProcessor, AutoModel


@dataclass
class Prediction:
    label: str          # pill label / NDC code, e.g. "53808-0895"
    score: float        # cosine similarity in [-1, 1]
    ref_path: str       # absolute path of the best-matching reference image
                        # (as stored at training time; mapped to the dataset
                        # zip when serving the thumbnail)


def _resolve_device(device: str) -> torch.device:
    if device == "auto":
        if torch.cuda.is_available():
            return torch.device("cuda")
        if torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")
    return torch.device(device)


class ProjectionHead(nn.Module):
    """Must match the architecture used during training exactly."""

    def __init__(self, in_dim: int, hidden_dim: int, out_dim: int, num_classes: int):
        super().__init__()
        self.proj = nn.Sequential(
            nn.Linear(in_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(0.10),
            nn.Linear(hidden_dim, out_dim),
        )
        self.classifier = nn.Linear(out_dim, num_classes)
        # ArcFace weights are part of the trained state_dict even though they are
        # not used for retrieval inference.
        self.arc_weight = nn.Parameter(torch.empty(num_classes, out_dim))
        nn.init.xavier_uniform_(self.arc_weight)

    def forward(self, x, labels=None):
        emb = F.normalize(self.proj(x), dim=1)
        logits = self.classifier(emb)
        return {"emb": emb, "logits": logits}


class DinoV2PillClassifier:
    def __init__(self, model_dir: Path, device: str = "auto"):
        self.device = _resolve_device(device)
        print(f"[classifier] Using device: {self.device}")

        with open(model_dir / "config.json", "r") as f:
            cfg = json.load(f)

        ckpt_path = model_dir / "dinov2_projection_head" / "best_projection_head.pt"
        if not ckpt_path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {ckpt_path}")
        ckpt = torch.load(ckpt_path, map_location=self.device)

        # Frozen DINOv2 backbone (weights downloaded from HuggingFace on first run).
        self.processor = AutoImageProcessor.from_pretrained(cfg["dinov2_model_id"])
        self.dinov2_model = AutoModel.from_pretrained(cfg["dinov2_model_id"])
        self.dinov2_model.eval().to(self.device)
        for param in self.dinov2_model.parameters():
            param.requires_grad = False

        self.projection_head = ProjectionHead(
            in_dim=ckpt["in_dim"],
            hidden_dim=cfg["proj_hidden_dim"],
            out_dim=cfg["proj_embedding_dim"],
            num_classes=ckpt["num_classes"],
        )
        self.projection_head.load_state_dict(ckpt["head_state_dict"])
        self.projection_head.eval().to(self.device)

        ref_path = model_dir / "dinov2_projection_head" / "deployed_ref_embeddings.pt"
        if not ref_path.exists():
            raise FileNotFoundError(f"Reference embeddings not found: {ref_path}")
        ref_data = torch.load(ref_path, map_location=self.device)
        self.ref_embeddings = F.normalize(ref_data["embeddings"].to(self.device), dim=1)
        self.ref_label_indices = ref_data["label_indices"].to(self.device)
        self.label_strings = np.array(ckpt["label_classes"])
        self.ref_abs_paths = np.array(ref_data["abs_paths"])

        self.num_reference_pills = int(self.label_strings.shape[0])
        print(
            f"[classifier] Loaded {self.ref_embeddings.shape[0]} reference embeddings "
            f"across {self.num_reference_pills} pill classes."
        )

    @torch.no_grad()
    def _embed(self, image: Image.Image) -> torch.Tensor:
        inputs = self.processor(images=image, return_tensors="pt")
        pixel_values = inputs["pixel_values"].to(self.device)
        with torch.autocast(device_type=self.device.type, enabled=(self.device.type == "cuda")):
            outputs = self.dinov2_model(pixel_values=pixel_values)
            if getattr(outputs, "pooler_output", None) is not None:
                feat = outputs.pooler_output
            else:
                feat = outputs.last_hidden_state[:, 0]
        emb = self.projection_head(feat.float())["emb"]
        return F.normalize(emb, dim=1)

    @torch.no_grad()
    def predict_topk(self, image: Image.Image, k: int = 10) -> List[Prediction]:
        query_emb = self._embed(image)
        similarities = (query_emb @ self.ref_embeddings.T).squeeze(0)

        # Best similarity per pill label.
        scores_by_label = torch.full(
            (self.label_strings.shape[0],), -torch.inf, device=self.device
        )
        scores_by_label.scatter_reduce_(
            0, self.ref_label_indices, similarities, reduce="amax", include_self=True
        )

        k = min(k, self.num_reference_pills)
        top_scores, top_label_indices = scores_by_label.topk(k)

        predictions: List[Prediction] = []
        for score, label_idx in zip(top_scores.cpu().tolist(), top_label_indices):
            mask = self.ref_label_indices == label_idx
            sims_for_label = similarities[mask]
            ref_path = "N/A"
            if sims_for_label.numel() > 0:
                best_local = torch.argmax(sims_for_label)
                global_idx = torch.nonzero(mask).squeeze(1)[best_local]
                ref_path = str(self.ref_abs_paths[global_idx.item()])
            predictions.append(
                Prediction(
                    label=str(self.label_strings[label_idx.item()]),
                    score=float(score),
                    ref_path=ref_path,
                )
            )
        return predictions
