export type PredictionResult = {
  label: string;
  ndc: string | null;
  name: string | null;
  imprint: string | null;
  color: string | null;
  status: string | null;
  score: number;
  score_pct: number;
  imprint_match_score?: number;
  fused_score?: number;
  reference_image_url: string | null;
};

export type PredictResponse = {
  predictions: PredictionResult[];
  ocr_imprint_read: string | null;
  low_confidence: boolean;
};

const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export async function predictPill(file: File, fileBack?: File | null): Promise<PredictResponse> {
  const formData = new FormData();
  formData.append("file", file);
  if (fileBack) {
    formData.append("file_back", fileBack);
  }

  const response = await fetch(`${apiBase}/api/predict`, {
    method: "POST",
    body: formData,
    headers: {
      // This tells Ngrok to shut up and just serve the data instantly!
      "ngrok-skip-browser-warning": "true",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Prediction request failed with status ${response.status}`);
  }

  return (await response.json()) as PredictResponse;
}

// 1. Keep this dead simple to construct the absolute path
export function referenceImageSrc(referenceImageUrl: string | null) {
  if (!referenceImageUrl) return "";
  if (referenceImageUrl.startsWith("http")) return referenceImageUrl;
  return `${apiBase}${referenceImageUrl}`;
}

// 2. Add this brand new function to safely fetch the secure blob via headers
export async function fetchSecureImageBlob(url: string): Promise<string> {
  if (!url) return "";

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "ngrok-skip-browser-warning": "true",
      },
    });

    if (!response.ok) throw new Error("Image fetch failed");

    const blob = await response.blob();
    return URL.createObjectURL(blob); // Generates a safe local 'blob://' link Safari will render perfectly
  } catch (error) {
    console.error("Error securing image resource:", error);
    return url; // Fallback to raw URL if fetch fails
  }
}

// ── v2 UI support ──────────────────────────────────────────────────────────
// Scanner (v2) works with an in-memory <canvas> instead of a <input type=file>
// selection, so these helpers adapt that shape onto the same /api/predict call
// v1 uses, instead of running a separate ONNX model in-browser.

export type PillMatch = {
  label: string;
  ndc: string | null;
  drug_name: string | null;
  score: number;
  reference_image_url: string | null;
};

export type IdentifyResult = {
  matches: PillMatch[];
  lowConfidence: boolean;
  ocrImprintRead: string | null;
};

export function canvasToFile(canvas: HTMLCanvasElement, quality = 0.9): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not process image. Please try again."));
          return;
        }
        resolve(new File([blob], "scan.jpg", { type: "image/jpeg" }));
      },
      "image/jpeg",
      quality
    );
  });
}

export async function identifyPill(
  canvas: HTMLCanvasElement,
  topN = 5,
  backCanvas?: HTMLCanvasElement | null
): Promise<IdentifyResult> {
  const file = await canvasToFile(canvas);
  const fileBack = backCanvas ? await canvasToFile(backCanvas) : null;
  const { predictions, low_confidence, ocr_imprint_read } = await predictPill(file, fileBack);

  const top = predictions.slice(0, topN);
  const matches = await Promise.all(
    top.map(async (p) => ({
      label: p.label,
      ndc: p.ndc,
      drug_name: p.name && p.name.trim() !== "" ? p.name : null,
      score: p.score,
      reference_image_url: p.reference_image_url
        ? await fetchSecureImageBlob(referenceImageSrc(p.reference_image_url))
        : null,
    }))
  );
  return { matches, lowConfidence: low_confidence, ocrImprintRead: ocr_imprint_read };
}
