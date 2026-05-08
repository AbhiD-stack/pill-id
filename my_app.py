import os
from pathlib import Path
from PIL import Image

# Import the DinoV2PillClassifier from your deployment script
# Make sure deploy_model.py is in the same directory, or adjust the import path.
from deploy_model import DinoV2PillClassifier

def run_my_application():
    # Define the directory where your model artifacts are located.
    # This should be the root of your 'pill-id' project.
    MODEL_ARTIFACTS_DIR = Path("./") # Assuming artifacts are in the current directory

    # --- Initialize the Classifier ---
    print(f"\nInitializing DinoV2PillClassifier from {MODEL_ARTIFACTS_DIR}...")
    try:
        classifier = DinoV2PillClassifier(MODEL_ARTIFACTS_DIR)
        print("Classifier initialized successfully!")
    except FileNotFoundError as e:
        print(f"ERROR: Model artifacts missing. Please ensure they are in {MODEL_ARTIFACTS_DIR}. {e}")
        return
    except Exception as e:
        print(f"An unexpected error occurred during classifier initialization: {e}")
        return

    # --- Example: Make a prediction ---
    # IMPORTANT: Replace 'path/to/your/test_image.jpg' with an actual path to an image file
    # For example, if you put a test image named 'my_test_pill.jpg' in the same directory:
    test_image_path = Path('C:/Users/kvd_/OneDrive/Documents/GitHub/pill-id/20.jpg') # <--- MODIFY THIS LINE

    if not test_image_path.exists():
        print(f"\nERROR: Test image not found at {test_image_path}. Please provide a valid image path.")
        return

    try:
        input_image = Image.open(test_image_path).convert('RGB')
        print(f"\nMaking a prediction for image: {test_image_path}")
        top_k_predictions = classifier.predict_topk(input_image, k=5)

        print("Top 5 Predictions:")
        for label, score, ref_path in top_k_predictions:
            print(f"  Label: {label}, Score: {score:.4f}, Ref Image Path: {ref_path}")
    except Exception as e:
        print(f"\nERROR processing prediction for {test_image_path}: {e}")

if __name__ == "__main__":
    run_my_application()
