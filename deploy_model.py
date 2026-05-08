import os
import json
import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
import pandas as pd
from PIL import Image
from transformers import AutoImageProcessor, AutoModel
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any

# --- ProjectionHead class definition (copied from notebook) ---
# This must exactly match the definition used during training.
class ProjectionHead(nn.Module):
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
        # Arcface weights are part of the trained state_dict, even if not used for direct inference here.
        self.arc_weight = nn.Parameter(torch.empty(num_classes, out_dim))
        nn.init.xavier_uniform_(self.arc_weight)

    def forward(self, x, labels=None):
        # For inference, we only need the normalized embedding
        emb = F.normalize(self.proj(x), dim=1)
        # logits and arc_logits are not typically needed for retrieval inference,
        # but the weights for classifier are part of the state_dict.
        logits = self.classifier(emb)
        return {"emb": emb, "logits": logits}
# --------------------------------------------------------------

class DinoV2PillClassifier:
    def __init__(self, model_dir: Path, device: Optional[torch.device] = None):
        self.device = device if device else torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Using device: {self.device}")

        # Load configuration used during training
        with open(model_dir / "config.json", "r") as f:
            cfg = json.load(f)

        # Load ProjectionHead checkpoint to get model parameters
        ckpt_path = model_dir / "dinov2_projection_head" / "best_projection_head.pt"
        if not ckpt_path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {ckpt_path}. Make sure it was saved correctly.")

        ckpt = torch.load(ckpt_path, map_location=self.device)

        # Initialize DINOv2 processor and model (frozen backbone)
        self.processor = AutoImageProcessor.from_pretrained(cfg["dinov2_model_id"])
        self.dinov2_model = AutoModel.from_pretrained(cfg["dinov2_model_id"])
        self.dinov2_model.eval().to(self.device)
        for param in self.dinov2_model.parameters():
            param.requires_grad = False

        # Initialize and load the ProjectionHead
        in_dim = ckpt["in_dim"]
        num_classes = ckpt["num_classes"]
        self.projection_head = ProjectionHead(
            in_dim=in_dim,
            hidden_dim=cfg["proj_hidden_dim"],
            out_dim=cfg["proj_embedding_dim"],
            num_classes=num_classes
        )
        self.projection_head.load_state_dict(ckpt["head_state_dict"])
        self.projection_head.eval().to(self.device)

        # Load projected reference embeddings
        ref_embeddings_path = model_dir / "dinov2_projection_head" / "deployed_ref_embeddings.pt"
        if not ref_embeddings_path.exists():
            raise FileNotFoundError(f"Deployed reference embeddings not found: {ref_embeddings_path}. Make sure they were saved.")

        ref_data = torch.load(ref_embeddings_path, map_location=self.device)
        self.ref_embeddings = ref_data["embeddings"].to(self.device)
        self.ref_label_indices = ref_data["label_indices"].to(self.device)
        self.label_strings = np.array(ckpt["label_classes"])
        self.ref_abs_paths = np.array(ref_data["abs_paths"]) # Store reference image paths

        # Normalize reference embeddings once
        self.ref_embeddings = F.normalize(self.ref_embeddings, dim=1)

    @torch.no_grad()
    def _extract_and_project_features(self, image: Image.Image) -> torch.Tensor:
        inputs = self.processor(images=image, return_tensors="pt")
        pixel_values = inputs["pixel_values"].to(self.device)

        with torch.autocast(device_type=self.device.type, enabled=(self.device.type == "cuda")):
            outputs = self.dinov2_model(pixel_values=pixel_values)
            if hasattr(outputs, "pooler_output") and outputs.pooler_output is not None:
                feat = outputs.pooler_output
            else:
                feat = outputs.last_hidden_state[:, 0]

        projected_feat = self.projection_head(feat.float())["emb"]
        return F.normalize(projected_feat, dim=1)

    @torch.no_grad()
    def predict_topk(self, image: Image.Image, k: int = 5) -> List[Tuple[str, float, str]]: # Updated return type hint
        query_emb = self._extract_and_project_features(image)

        # Compute cosine similarity with all reference embeddings
        similarities = query_emb @ self.ref_embeddings.T

        # Get the max similarity for each unique label in the reference set
        # This effectively performs the 'label_score_matrix' logic for a single query
        scores_by_label = torch.full((self.label_strings.shape[0],), -torch.inf, device=self.device)
        scores_by_label.scatter_reduce_(0, self.ref_label_indices, similarities.squeeze(0), reduce="amax", include_self=True)

        # Get top-k predicted label indices and their scores
        top_scores, top_label_indices = scores_by_label.topk(k)

        # Map label indices back to original label strings
        top_labels = [self.label_strings[idx.item()] for idx in top_label_indices]

        # Find the specific reference image path that yielded the max similarity for each top label
        top_ref_paths = []
        for label_idx in top_label_indices:
            # Find all reference embeddings that match this label_idx
            matching_refs_mask = (self.ref_label_indices == label_idx)
            # Get similarities for only these matching references
            sims_for_label = similarities.squeeze(0)[matching_refs_mask]
            if sims_for_label.numel() > 0:
                # Find the index within the matching_refs_mask that corresponds to the max similarity
                max_sim_local_idx = torch.argmax(sims_for_label)
                # Get the global index of this reference embedding
                global_ref_indices = torch.nonzero(matching_refs_mask).squeeze(1)
                corresponding_ref_global_idx = global_ref_indices[max_sim_local_idx]
                top_ref_paths.append(self.ref_abs_paths[corresponding_ref_global_idx.item()])
            else:
                top_ref_paths.append("N/A") # Should not happen if label exists in ref_data

        return list(zip(top_labels, top_scores.cpu().tolist(), top_ref_paths))


if __name__ == "__main__":
    # The MODEL_ARTIFACTS_DIR is set to the current directory ('.')
    # assuming you've placed 'config.json' and the 'dinov2_projection_head' folder
    # directly in the root of your 'pill-id' repository as instructed in Step 4.
    # If your artifacts are in a different location (e.g., an absolute path on Windows),
    # make sure to use forward slashes or a raw string literal to avoid SyntaxErrors.
    # For example: MODEL_ARTIFACTS_DIR = Path("C:/Users/YourUser/project/my_deployed_model")
    # Or: MODEL_ARTIFACTS_DIR = Path(r"C:\Users\YourUser\project\my_deployed_model")
    MODEL_ARTIFACTS_DIR = Path("./")

    print(f"\nLoading model from {MODEL_ARTIFACTS_DIR}...")
    classifier = DinoV2PillClassifier(MODEL_ARTIFACTS_DIR)
    print("Model loaded successfully!")

    # IMPORTANT: Replace 'path/to/your/test_image.jpg' with the actual path to an image file
    # you want to use for testing. This image should be accessible from your VS Code project.
    # For example, you could place a test image named 'test_pill.jpg' next to deploy_model.py
    # and set test_image_path = Path('./test_pill.jpg')
    # On Windows, use forward slashes or a raw string literal:
    # test_image_path = Path("C:/Users/YourUser/project/test_pill.jpg")
    # test_image_path = Path(r"C:\Users\YourUser\project\test_pill.jpg")
    test_image_path = Path('./20.jpg') # <--- MODIFY THIS LINE

    if not test_image_path.exists():
        print(f"\nERROR: Test image not found at {test_image_path}. Please update 'test_image_path' to a valid image file.")
    else:
        try:
            # Open and display the test image
            print(f"\nTest image: {test_image_path}")
            try:
                test_image = Image.open(test_image_path).convert('RGB')
                # For local environments, Image.show() attempts to open the image
                # using a default viewer. You might need to install an image viewer
                # or configure PIL's image viewer backend for this to work.
                # Alternatively, you could save the image to a temporary file and open it programmatically.
                test_image.show(title="Test Image")
            except Exception as display_e:
                print(f"  Could not display test image locally: {display_e}. Please view {test_image_path} manually.")

            print(f"\nMaking a prediction on {test_image_path}:")
            predictions = classifier.predict_topk(test_image, k=3)
            print("Top 3 Predictions:")
            for i, (label, score, ref_path) in enumerate(predictions):
                print(f"  {i+1}. Label: {label}, Score: {score:.4f}, Ref Image Path: {ref_path}")
                try:
                    ref_image = Image.open(ref_path).convert('RGB')
                    ref_image.show(title=f"Ref Image for {label} (Score: {score:.4f})")
                except Exception as display_e:
                    print(f"  Could not display reference image locally for {label}: {display_e}. Please view {ref_path} manually.")
        except Exception as e:
            print(f"\nERROR processing test image: {e}")

    print("\nDeployment script ready. Integrate DinoV2PillClassifier into your local application!")