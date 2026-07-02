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
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Prediction request failed with status ${response.status}`);
  }

  return (await response.json()) as { predictions: PredictionResult[] };
}

export function referenceImageSrc(referenceImageUrl: string | null) {
  if (!referenceImageUrl) return "";
  if (referenceImageUrl.startsWith("http")) return referenceImageUrl;
  return `${apiBase}${referenceImageUrl}`;
}
