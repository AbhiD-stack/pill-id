export type PredictionResult = {
  label: string;
  ndc: string | null;
  name: string | null;
  imprint: string | null;
  color: string | null;
  status: string | null;
  score: number;
  score_pct: number;
  reference_image_url: string | null;
};

const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");

export async function predictPill(file: File) {
  const formData = new FormData();
  formData.append("file", file);

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

  return (await response.json()) as { predictions: PredictionResult[] };
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
        "ngrok-skip-browser-warning": "true"
      }
    });
    
    if (!response.ok) throw new Error("Image fetch failed");
    
    const blob = await response.blob();
    return URL.createObjectURL(blob); // Generates a safe local 'blob://' link Safari will render perfectly
  } catch (error) {
    console.error("Error securing image resource:", error);
    return url; // Fallback to raw URL if fetch fails
  }
}
