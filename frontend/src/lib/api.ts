export type PredictionResult = {
  label: string;
  ndc: string | null;
  name: string | null;
  imprint: string | null;
  color: string | null;
  shape: string | null;
  score_marks: string | null;
  status: string | null;
  score: number;
  score_pct: number;
  reference_image_url: string | null;
};

const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

// ── V3 support: name search, attribute-filter search, bottle-label OCR ─────
// These don't involve the image-similarity model at all -- they're a separate
// lookup over the same reference-image/drug-name data, used by V3's "My
// Pills" name lookup and its scan-fallback filters.

export type CatalogMatch = {
  label: string;
  ndc: string | null;
  name: string | null;
  imprint: string | null;
  color: string | null;
  shape: string | null;
  score_marks: string | null;
  status: string | null;
  reference_image_url: string | null;
};

// Reads an error response body and returns a short, human-readable message.
// The backend returns JSON ({"detail": "..."}), but if a request never
// reaches it (misconfigured NEXT_PUBLIC_API_URL, backend down, a proxy's own
// 404/502 page) the body can be an HTML error page instead -- dumping that
// raw HTML into the UI is worse than a generic message, so we only surface
// text that looks like a short, real error.
async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.clone().json();
    if (typeof data?.detail === "string") return data.detail;
  } catch {
    // not JSON, fall through to plain text
  }
  try {
    const text = (await response.text()).trim();
    if (text && text.length < 200 && !text.startsWith("<")) return text;
  } catch {
    // ignore
  }
  return fallback;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { "ngrok-skip-browser-warning": "true" },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Request failed (${response.status}). Please try again.`));
  }
  return response.json();
}

export async function searchByName(name: string, limit = 20): Promise<CatalogMatch[]> {
  if (!name.trim()) return [];
  const { matches } = await getJson<{ matches: CatalogMatch[] }>(
    `/api/search?name=${encodeURIComponent(name)}&limit=${limit}`
  );
  return matches;
}

export type AttributeFilters = {
  color?: string;
  shape?: string;
  imprint?: string;
  score?: string;
};

export async function searchByAttributes(filters: AttributeFilters, limit = 20): Promise<CatalogMatch[]> {
  const params = new URLSearchParams();
  if (filters.color) params.set("color", filters.color);
  if (filters.shape) params.set("shape", filters.shape);
  if (filters.imprint) params.set("imprint", filters.imprint);
  if (filters.score) params.set("score", filters.score);
  if ([...params.keys()].length === 0) return [];
  params.set("limit", String(limit));
  const { matches } = await getJson<{ matches: CatalogMatch[] }>(
    `/api/search-by-attributes?${params.toString()}`
  );
  return matches;
}

export async function ocrLabel(file: File): Promise<{ raw_text: string; candidates: CatalogMatch[] }> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${apiBase}/api/ocr-label`, {
    method: "POST",
    body: formData,
    headers: { "ngrok-skip-browser-warning": "true" },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `OCR failed (${response.status}). Please try again.`));
  }
  return response.json();
}

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

export async function identifyPill(canvas: HTMLCanvasElement, topN = 5): Promise<PillMatch[]> {
  const file = await canvasToFile(canvas);
  const { predictions } = await predictPill(file);

  const top = predictions.slice(0, topN);
  return Promise.all(
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
}
