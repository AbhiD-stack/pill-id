import tkinter as tk
from tkinter import filedialog, ttk
from PIL import Image, ImageTk
import zipfile
from pathlib import Path
import io

# Import the DinoV2PillClassifier from your deploy_model.py script.
# Make sure deploy_model.py is in the same directory.
from deploy_model import DinoV2PillClassifier

# Define the directory where your model artifacts are located.
# This should be the root of your 'pill-id' project, where config.json and
# the dinov2_projection_head folder are located.
MODEL_ARTIFACTS_DIR = Path("./")


# Define the root directory of your local ePillID dataset.
# This is used to map the Colab paths stored in the model's reference data
# to your local file system for displaying reference images.
LOCAL_DATASET_ROOT = Path("C:/Users/kvd_/OneDrive/Documents/ePillID_data") # <--- USER'S LOCAL DATASET ROOT

# Path to the zip file containing the dataset
DATASET_ZIP_PATH = Path("C:/Users/kvd_/OneDrive/Documents/ePillID_data.zip")

class PillPredictionApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Pill Identifier")

        self.classifier = None
        self.current_image = None
        self.current_photo = None

        # --- Initialize Model ---
        self.status_label = ttk.Label(root, text="Initializing model...", font=('Arial', 10, 'italic'))
        self.status_label.pack(pady=5)
        self.root.update_idletasks() # Update GUI to show message

        try:
            self.classifier = DinoV2PillClassifier(MODEL_ARTIFACTS_DIR)
            self.status_label.config(text="Model initialized successfully! Ready for predictions.", foreground='green')
        except FileNotFoundError as e:
            self.status_label.config(text=f"ERROR: Model artifacts missing. Ensure they are in {MODEL_ARTIFACTS_DIR}. {e}", foreground='red')
            print(f"ERROR: {e}")
        except Exception as e:
            self.status_label.config(text=f"An unexpected error occurred during model initialization: {e}", foreground='red')
            print(f"ERROR: {e}")

        # --- GUI Elements ---
        self.create_widgets()

    def create_widgets(self):
        # Frame for buttons
        button_frame = ttk.Frame(self.root)
        button_frame.pack(pady=10)

        self.upload_button = ttk.Button(button_frame, text="Upload Image", command=self.upload_image)
        self.upload_button.pack(side=tk.LEFT, padx=10)

        self.predict_button = ttk.Button(button_frame, text="Predict", command=self.predict_current_image, state=tk.DISABLED)
        self.predict_button.pack(side=tk.LEFT, padx=10)

        # Image display area
        self.image_label = ttk.Label(self.root)
        self.image_label.pack(pady=10)

        # Predictions display area
        self.predictions_text = tk.Text(self.root, height=10, width=80, state=tk.DISABLED, wrap=tk.WORD, font=('Courier New', 10))
        self.predictions_text.pack(pady=10, padx=10)

    def upload_image(self):
        file_path = filedialog.askopenfilename(
            title="Select an image file",
            filetypes=[("Image files", "*.jpg *.jpeg *.png *.gif *.bmp"), ("All files", "*.*")])

        if file_path:
            try:
                self.current_image = Image.open(file_path).convert('RGB')
                self.display_image(self.current_image)
                self.predict_button.config(state=tk.NORMAL if self.classifier else tk.DISABLED)
                self.update_predictions_text("Image loaded. Click 'Predict' to get results.")
                self.status_label.config(text="Image loaded. Ready for prediction.", foreground='black')
            except Exception as e:
                self.status_label.config(text=f"ERROR loading image: {e}", foreground='red')
                self.update_predictions_text(f"Error loading image: {e}")
                self.predict_button.config(state=tk.DISABLED)

    def display_image(self, image):
        # Resize image to fit in the window while maintaining aspect ratio
        max_size = (400, 400) # Maximum display size
        image.thumbnail(max_size, Image.Resampling.LANCZOS)
        self.current_photo = ImageTk.PhotoImage(image)
        self.image_label.config(image=self.current_photo)

    def map_colab_path_to_zip(self, colab_path: str) -> str:
        # Returns the internal path inside the zip file for a given colab path
        parts = Path(colab_path).parts
        try:
            start_idx = parts.index('ePillID_data')
            # Always keep 'ePillID_data' as the first part in the zip
            zip_path = '/'.join(parts[start_idx:])
            return zip_path
        except ValueError:
            try:
                start_idx = parts.index('extracted')
                if 'ePillID_data' in parts[start_idx+1:]:
                    eid_idx = parts.index('ePillID_data', start_idx+1)
                    zip_path = '/'.join(parts[eid_idx:])
                    return zip_path
                else:
                    zip_path = '/'.join(parts[start_idx+1:])
                    return zip_path
            except ValueError:
                print(f"Warning: Could not automatically map Colab path {colab_path}. Returning original path.")
                return colab_path.replace('\\', '/')


    def predict_current_image(self):
        if not self.classifier:
            self.update_predictions_text("Model not initialized. Cannot predict.")
            self.status_label.config(text="Error: Model not initialized.", foreground='red')
            return
        if not self.current_image:
            self.update_predictions_text("No image loaded. Please upload an image first.")
            self.status_label.config(text="Error: No image loaded.", foreground='red')
            return

        self.status_label.config(text="Making predictions...", foreground='blue')
        self.root.update_idletasks()

        try:
            predictions = self.classifier.predict_topk(self.current_image, k=10)
            results_str = "Top 5 Predictions:\n"
            # Frame for reference images
            if hasattr(self, 'ref_images_frame'):
                self.ref_images_frame.destroy()
            self.ref_images_frame = ttk.Frame(self.root)
            self.ref_images_frame.pack(pady=5)
            self.ref_photos = []  # Keep references to PhotoImage objects
            # Open the zip file once
            with zipfile.ZipFile(DATASET_ZIP_PATH, 'r') as zf:
                for i, (label, score, ref_path) in enumerate(predictions):
                    zip_ref_path = self.map_colab_path_to_zip(ref_path)
                    results_str += f"  {i+1}. Label: {label}, Score: {score:.4f}, Ref Image Path: {zip_ref_path}\n"
                    try:
                        with zf.open(zip_ref_path) as img_file:
                            ref_image = Image.open(img_file).convert('RGB')
                            ref_image.thumbnail((100, 100), Image.Resampling.LANCZOS)
                            ref_photo = ImageTk.PhotoImage(ref_image)
                            self.ref_photos.append(ref_photo)
                            ref_label = ttk.Label(self.ref_images_frame, image=ref_photo)
                            ref_label.grid(row=0, column=i, padx=5)
                            ref_label_txt = ttk.Label(self.ref_images_frame, text=f"{label}\n{score:.2f}", font=("Arial", 8))
                            ref_label_txt.grid(row=1, column=i, padx=5)
                    except Exception as display_e:
                        print(f"  Could not display reference image from zip for {label}: {display_e}. Please check {zip_ref_path} in the zip archive.")

            self.update_predictions_text(results_str)
            self.status_label.config(text="Prediction complete!", foreground='green')
        except Exception as e:
            self.status_label.config(text=f"ERROR during prediction: {e}", foreground='red')
            self.update_predictions_text(f"Error during prediction: {e}")

    def update_predictions_text(self, text):
        self.predictions_text.config(state=tk.NORMAL)
        self.predictions_text.delete('1.0', tk.END)
        self.predictions_text.insert(tk.END, text)
        self.predictions_text.config(state=tk.DISABLED)

if __name__ == "__main__":
    root = tk.Tk()
    app = PillPredictionApp(root)
    root.mainloop()