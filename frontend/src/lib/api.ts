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
  imprint_match_score?: number;
  fused_score?: number;
  reference_image_url: string | null;
};

export type PredictResponse = {
  prediction_id: string;
  predictions: PredictionResult[];
  ocr_imprint_read: string | null;
  low_confidence: boolean;
  // "restricted" = searched only priority-tier RX/OTC (the much higher-accuracy
  // mode, 93-98% top10 measured); "unrestricted" = full gallery fallback (89.5%
  // top10), used when rxOrOtc is omitted/"unknown" or not available server-side.
  search_mode: "restricted" | "unrestricted";
};

// "RX" | "OTC" restricts the search to that category's priority-tier drugs
// (the "ask RX/OTC/don't know" app mode) -- omit or pass null/"unknown" for
// "don't know", which falls back to the full, lower-accuracy gallery search.
export type RxOrOtc = "RX" | "OTC" | null;

export type SearchResult = {
  label: string;
  ndc: string | null;
  name: string | null;
  imprint: string | null;
  color: string | null;
  shape: string | null;
  score_marks: string | null;
  reference_image_url: string | null;
  match_count?: number;
};

const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export async function predictPill(
  file: File,
  fileBack?: File | null,
  rxOrOtc?: RxOrOtc
): Promise<PredictResponse> {
  const formData = new FormData();
  formData.append("file", file);
  if (fileBack) {
    formData.append("file_back", fileBack);
  }
  if (rxOrOtc) {
    formData.append("rx_or_otc", rxOrOtc);
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

// "None of these were right" (or "this one was right") feedback, tied to the
// actual photo via prediction_id. This is currently the ONLY source of real
// consumer-domain (phone-photo) accuracy data this project has -- every gate
// number so far comes from the same curated-source distribution as training.
// Best-effort: a feedback failure should never block or disrupt the user's
// actual identification flow, so callers should treat a thrown error here as
// non-fatal (log it, don't surface it as if the scan itself failed).
export async function submitFeedback(
  predictionId: string,
  correct: boolean,
  reportedLabel?: string | null,
  notes?: string | null
): Promise<void> {
  const formData = new FormData();
  formData.append("prediction_id", predictionId);
  formData.append("correct", String(correct));
  if (reportedLabel) formData.append("reported_label", reportedLabel);
  if (notes) formData.append("notes", notes);

  const response = await fetch(`${apiBase}/api/feedback`, {
    method: "POST",
    body: formData,
    headers: { "ngrok-skip-browser-warning": "true" },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Feedback request failed with status ${response.status}`);
  }
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
  imprint: string | null;
  color: string | null;
  shape: string | null;
  score: number;
  reference_image_url: string | null;
};

export type IdentifyResult = {
  matches: PillMatch[];
  lowConfidence: boolean;
  ocrImprintRead: string | null;
  predictionId: string;
  searchMode: "restricted" | "unrestricted";
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
  backCanvas?: HTMLCanvasElement | null,
  rxOrOtc?: RxOrOtc
): Promise<IdentifyResult> {
  const file = await canvasToFile(canvas);
  const fileBack = backCanvas ? await canvasToFile(backCanvas) : null;
  const { prediction_id, predictions, low_confidence, ocr_imprint_read, search_mode } =
    await predictPill(file, fileBack, rxOrOtc);

  const top = predictions.slice(0, topN);
  const matches = await Promise.all(
    top.map(async (p) => ({
      label: p.label,
      ndc: p.ndc,
      drug_name: p.name && p.name.trim() !== "" ? p.name : null,
      imprint: p.imprint,
      color: p.color,
      shape: p.shape,
      score: p.score,
      reference_image_url: p.reference_image_url
        ? await fetchSecureImageBlob(referenceImageSrc(p.reference_image_url))
        : null,
    }))
  );
  return {
    matches,
    lowConfidence: low_confidence,
    ocrImprintRead: ocr_imprint_read,
    predictionId: prediction_id,
    searchMode: search_mode,
  };
}

async function _resolveSearchResultImages(results: SearchResult[]): Promise<SearchResult[]> {
  return Promise.all(
    results.map(async (r) => ({
      ...r,
      reference_image_url: r.reference_image_url
        ? await fetchSecureImageBlob(referenceImageSrc(r.reference_image_url))
        : null,
    }))
  );
}

// "What does <drug name> look like" -- the opposite direction from a photo
// scan: look a medication up by name and see its known appearance.
export async function searchByName(query: string): Promise<SearchResult[]> {
  const response = await fetch(`${apiBase}/api/search-by-name?q=${encodeURIComponent(query)}`, {
    headers: { "ngrok-skip-browser-warning": "true" },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Search failed with status ${response.status}`);
  }
  const { results } = (await response.json()) as { results: SearchResult[] };
  return _resolveSearchResultImages(results);
}

// Fallback for when the photo-based match misses: describe the pill
// (color/shape/imprint/score marks) instead of showing a photo, the same
// idea as Epocrates' manual pill identifier.
export async function searchByAppearance(criteria: {
  color?: string;
  shape?: string;
  imprint?: string;
  scoreMarks?: string;
}): Promise<SearchResult[]> {
  const params = new URLSearchParams();
  if (criteria.color) params.set("color", criteria.color);
  if (criteria.shape) params.set("shape", criteria.shape);
  if (criteria.imprint) params.set("imprint", criteria.imprint);
  if (criteria.scoreMarks) params.set("score_marks", criteria.scoreMarks);

  const response = await fetch(`${apiBase}/api/search-by-appearance?${params.toString()}`, {
    headers: { "ngrok-skip-browser-warning": "true" },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Search failed with status ${response.status}`);
  }
  const { results } = (await response.json()) as { results: SearchResult[] };
  return _resolveSearchResultImages(results);
}
