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
    def __init__(self, model_dir: Path, device: str = "auto", lora_adapter_dir: Optional[Path] = None,
                 label_meta_path: Optional[Path] = None):
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
        for param in self.dinov2_model.parameters():
            param.requires_grad = False

        # The reference gallery (deployed_ref_embeddings.pt) was computed AFTER
        # the training run's LoRA fine-tune phase, i.e. through a backbone with
        # this adapter applied -- not the plain base model. Serving must apply
        # the same adapter before embedding a query image, or query and
        # gallery embeddings come from two different backbones and every
        # cosine-similarity score is silently wrong (not an error -- it just
        # quietly returns worse/wrong matches with no indication anything is
        # off). get_peft_model() always zero-inits a fresh adapter, so this
        # must use PeftModel.from_pretrained to load the actual saved weights.
        if lora_adapter_dir is not None and Path(lora_adapter_dir).exists():
            from peft import PeftModel
            self.dinov2_model = PeftModel.from_pretrained(self.dinov2_model, str(lora_adapter_dir))
            print(f"[classifier] Applied LoRA adapter from {lora_adapter_dir}")
        else:
            print("[classifier] No LoRA adapter configured -- using the base DINOv2 backbone as-is. "
                  "This is WRONG if the attached checkpoint was trained with run_lora=true "
                  "(check config.json) -- query/gallery embeddings would come from different "
                  "backbones.")
        self.dinov2_model.eval().to(self.device)

        self.label_meta: dict[str, dict] = {}
        if label_meta_path is not None and Path(label_meta_path).exists():
            with open(label_meta_path) as f:
                self.label_meta = json.load(f)
            print(f"[classifier] Loaded label metadata (category/tier) for {len(self.label_meta)} labels.")
        else:
            print("[classifier] No label_meta.json found -- restricted-gallery search (RX/OTC) "
                  "unavailable; predict_topk will search the full unrestricted gallery only.")

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

        # Category masks for the "ask RX/OTC/don't know" app mode: RX or OTC
        # searches every label in that category. These used to also require
        # tier == "priority", which hid ~87% of labels (27k of 31k) -- any
        # pill from a manufacturer/repackager outside the priority list
        # (e.g. a store-brand acetaminophen) could never be returned at all,
        # however good the photo. The priority-only eval numbers don't apply
        # to this wider search; the unrestricted full gallery is used when
        # the caller doesn't supply rx_or_otc or no label_meta.json loaded.
        self._restricted_masks: dict[str, torch.Tensor] = {}
        if self.label_meta:
            for cat in ("RX", "OTC"):
                mask = torch.tensor(
                    [self.label_meta.get(str(lbl), {}).get("category") == cat for lbl in self.label_strings],
                    dtype=torch.bool, device=self.device,
                )
                if mask.any():
                    self._restricted_masks[cat] = mask
                    print(f"[classifier] Category mask for {cat}: {int(mask.sum())} labels.")

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
    def embed_images(self, images: List[Image.Image]) -> torch.Tensor:
        """(n, embedding_dim) L2-normalized embeddings, one row per image --
        the same space as the reference gallery, so callers can also compare
        against their own saved pill photos ("My Pills")."""
        return torch.cat([self._embed(img) for img in images], dim=0)

    @torch.no_grad()
    def _best_per_label(self, query_emb: torch.Tensor, label_mask: Optional[torch.Tensor] = None
                         ) -> tuple[torch.Tensor, torch.Tensor]:
        """Returns (scores_by_label, similarities) for a single (1, d) query
        embedding. label_mask (True = included), when given, excludes
        everything else by forcing it to -inf -- same effect as not having
        those labels in the gallery, without needing a second copy of
        ref_embeddings per mode."""
        similarities = (query_emb @ self.ref_embeddings.T).squeeze(0)
        scores_by_label = torch.full(
            (self.label_strings.shape[0],), -torch.inf, device=self.device
        )
        scores_by_label.scatter_reduce_(
            0, self.ref_label_indices, similarities, reduce="amax", include_self=True
        )
        if label_mask is not None:
            scores_by_label = scores_by_label.masked_fill(~label_mask, -torch.inf)
        return scores_by_label, similarities

    def ref_path_for_label(self, label: str) -> Optional[str]:
        """A representative reference-image path for a label, independent of
        any query image -- used by name/appearance search, which has no
        photo to score similarity against."""
        matches = np.nonzero(self.label_strings == label)[0]
        if matches.size == 0:
            return None
        label_idx = int(matches[0])
        mask = (self.ref_label_indices == label_idx).cpu().numpy()
        idxs = np.nonzero(mask)[0]
        if idxs.size == 0:
            return None
        return str(self.ref_abs_paths[idxs[0]])

    def has_restricted_mode(self, rx_or_otc: Optional[str]) -> bool:
        """Whether predict_topk(_multi) will actually restrict the gallery
        for this value, vs. silently falling back to the unrestricted
        search. Lets callers report which mode a response actually used."""
        return bool(rx_or_otc) and rx_or_otc in self._restricted_masks

    @torch.no_grad()
    def predict_topk(self, image: Image.Image, k: int = 10, rx_or_otc: Optional[str] = None) -> List[Prediction]:
        return self.predict_topk_multi([image], k=k, rx_or_otc=rx_or_otc)

    @torch.no_grad()
    def predict_topk_multi(self, images: List[Image.Image], k: int = 10,
                            rx_or_otc: Optional[str] = None) -> List[Prediction]:
        """Front/back-aware retrieval: each image is scored independently and the
        per-label scores are averaged (mean aggregation), matching the sidepair
        fusion strategy validated during training. Falls back to a single image
        seamlessly (the average of one value is itself).

        rx_or_otc: "RX" or "OTC" restricts to that category's priority-tier
        labels only (the "ask RX/OTC/don't know" app mode, and the search
        mode the training gate's 93-98% numbers were measured against). Any
        other value (None, "unknown", or a category with no loaded mask)
        falls back to the full unrestricted gallery -- always available,
        just measured lower (~89.5% top10)."""
        return self.predict_topk_from_embeddings(self.embed_images(images), k=k, rx_or_otc=rx_or_otc)

    @torch.no_grad()
    def predict_topk_from_embeddings(self, query_embs: torch.Tensor, k: int = 10,
                                     rx_or_otc: Optional[str] = None) -> List[Prediction]:
        """predict_topk_multi for already-computed embed_images() output, so
        a caller that also needs the embeddings doesn't run the backbone twice."""
        label_mask = self._restricted_masks.get(rx_or_otc) if rx_or_otc else None
        per_image = [self._best_per_label(q.unsqueeze(0), label_mask=label_mask) for q in query_embs]
        scores_by_label = torch.stack([s for s, _ in per_image], dim=0).mean(dim=0)
        similarities_per_image = [sims for _, sims in per_image]

        k = min(k, int((scores_by_label > -torch.inf).sum().item()))
        top_scores, top_label_indices = scores_by_label.topk(k)
        return [
            Prediction(
                label=str(self.label_strings[label_idx.item()]),
                score=float(score),
                ref_path=self._best_ref_path(label_idx, similarities_per_image),
            )
            for score, label_idx in zip(top_scores.cpu().tolist(), top_label_indices)
        ]

    def _best_ref_path(self, label_idx, similarities_per_image) -> str:
        """Best-matching reference image across whichever side (front/back)
        scored the label highest, not just the first image."""
        mask = self.ref_label_indices == label_idx
        ref_path = "N/A"
        best_sim = -torch.inf
        for sims in similarities_per_image:
            sims_for_label = sims[mask]
            if sims_for_label.numel() == 0:
                continue
            local_best = torch.argmax(sims_for_label)
            local_best_val = sims_for_label[local_best].item()
            if local_best_val > best_sim:
                best_sim = local_best_val
                global_idx = torch.nonzero(mask).squeeze(1)[local_best]
                ref_path = str(self.ref_abs_paths[global_idx.item()])
        return ref_path

    @torch.no_grad()
    def predictions_for_labels(self, query_embs: torch.Tensor, labels: List[str]) -> List[Prediction]:
        """Visual scores for specific labels (e.g. candidates found by imprint
        search that the visual top-k missed), scored exactly like
        predict_topk_from_embeddings. Labels not in the gallery are skipped."""
        if not hasattr(self, "_label_index"):
            self._label_index = {str(l): i for i, l in enumerate(self.label_strings)}
        idxs = [self._label_index[l] for l in labels if l in self._label_index]
        if not idxs:
            return []
        per_image = [self._best_per_label(q.unsqueeze(0)) for q in query_embs]
        scores_by_label = torch.stack([s for s, _ in per_image], dim=0).mean(dim=0)
        sims = [s for _, s in per_image]
        return [
            Prediction(
                label=str(self.label_strings[i]),
                score=float(scores_by_label[i].item()),
                ref_path=self._best_ref_path(torch.tensor(i, device=self.device), sims),
            )
            for i in idxs
            if torch.isfinite(scores_by_label[i])  # a label with no gallery images can't be scored
        ]
