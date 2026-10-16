export type PredictionResult = {
  label: string;
  ndc: string | null;
  name: string | null;
  // Other names the same physical pill is listed under (store brands etc.).
  also_sold_as?: string[];
  imprint: string | null;
  color: string | null;
  shape: string | null;
  score_marks: string | null;
  status: string | null;
  score: number;
  score_pct: number;
  imprint_match_score?: number;  // 0-1: how well the candidate's imprint matches the one used
  fused_score?: number;
  reference_image_url: string | null;
  // "pill_photo" = a real photo of the pill; "package" = package/label art
  // (the app draws the pill instead when it knows its shape/color).
  reference_image_kind?: ReferenceImageKind;
};

export type ReferenceImageKind = "pill_photo" | "package" | null;

export type PredictResponse = {
  prediction_id: string;
  predictions: PredictionResult[];
  ocr_imprint_read: string | null;
  low_confidence: boolean;
  // "restricted" = searched only priority-tier RX/OTC (the much higher-accuracy
  // mode, 93-98% top10 measured); "unrestricted" = full gallery fallback (89.5%
  // top10), used when rxOrOtc is omitted/"unknown" or not available server-side.
  search_mode: "restricted" | "unrestricted";
  // Where ocr_imprint_read came from: "user" = typed/confirmed by the user,
  // "ocr" = read automatically and unconfirmed, null = no imprint used.
  imprint_source?: "user" | "ocr" | null;
  // One embedding per uploaded side (front, then back). Stored with a pill
  // saved to "My Pills" and compared against future scans on-device. Absent
  // from older backends.
  query_embeddings?: number[][];
};

// "RX" | "OTC" restricts the search to that category's priority-tier drugs
// (the "ask RX/OTC/don't know" app mode) -- omit or pass null/"unknown" for
// "don't know", which falls back to the full, lower-accuracy gallery search.
export type RxOrOtc = "RX" | "OTC" | null;

export type SearchResult = {
  label: string;
  ndc: string | null;
  name: string | null;
  also_sold_as?: string[];
  imprint: string | null;
  color: string | null;
  shape: string | null;
  score_marks: string | null;
  reference_image_url: string | null;
  reference_image_kind?: ReferenceImageKind;
  match_count?: number;
};

const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export async function predictPill(
  file: File,
  fileBack?: File | null,
  rxOrOtc?: RxOrOtc,
  imprint?: string | null
): Promise<PredictResponse> {
  const formData = new FormData();
  formData.append("file", file);
  if (fileBack) {
    formData.append("file_back", fileBack);
  }
  if (rxOrOtc) {
    formData.append("rx_or_otc", rxOrOtc);
  }
  // imprint: the user-confirmed imprint ("" = the user says there is none);
  // null/undefined = no imprint step (the server reads the photo itself).
  if (imprint !== null && imprint !== undefined) {
    formData.append("imprint_confirmed", "true");
    if (imprint.trim()) formData.append("imprint", imprint.trim());
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
  also_sold_as: string[];
  imprint: string | null;
  color: string | null;
  shape: string | null;
  score_marks: string | null;
  score: number;
  imprint_match_score: number;
  reference_image_url: string | null;
  reference_image_kind: ReferenceImageKind;
};

export type IdentifyResult = {
  matches: PillMatch[];
  lowConfidence: boolean;
  ocrImprintRead: string | null;
  predictionId: string;
  imprintSource: "user" | "ocr" | null;
  queryEmbeddings: number[][] | null;
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
  imprint?: string | null
): Promise<IdentifyResult> {
  const file = await canvasToFile(canvas);
  const fileBack = backCanvas ? await canvasToFile(backCanvas) : null;
  const { prediction_id, predictions, low_confidence, ocr_imprint_read, imprint_source, query_embeddings } =
    await predictPill(file, fileBack, null, imprint);

  const top = predictions.slice(0, topN);
  const matches = await Promise.all(
    top.map(async (p) => ({
      label: p.label,
      ndc: p.ndc,
      drug_name: p.name && p.name.trim() !== "" ? p.name : null,
      also_sold_as: p.also_sold_as ?? [],
      imprint: p.imprint,
      color: p.color,
      shape: p.shape,
      score_marks: p.score_marks,
      score: p.score,
      imprint_match_score: p.imprint_match_score ?? 0,
      reference_image_kind: p.reference_image_kind ?? null,
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
    imprintSource: imprint_source ?? null,
    queryEmbeddings: query_embeddings && query_embeddings.length > 0 ? query_embeddings : null,
  };
}

// The imprint on each side as read from the photos -- a suggestion for the
// user to confirm or correct before matching.
export async function readImprint(
  front: HTMLCanvasElement,
  back?: HTMLCanvasElement | null
): Promise<{ side_1: string; side_2: string; source: "vision" | "ocr" }> {
  const formData = new FormData();
  formData.append("file", await canvasToFile(front));
  if (back) formData.append("file_back", await canvasToFile(back));
  const response = await fetch(`${apiBase}/api/read-imprint`, {
    method: "POST",
    body: formData,
    headers: { "ngrok-skip-browser-warning": "true" },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Imprint read failed with status ${response.status}`);
  }
  return response.json();
}

// Embeddings for a photo saved to "My Pills" before scans returned them.
export async function embedPhoto(photoDataUrl: string): Promise<number[][]> {
  const blob = await (await fetch(photoDataUrl)).blob();
  const formData = new FormData();
  formData.append("file", new File([blob], "pill.jpg", { type: blob.type || "image/jpeg" }));
  const response = await fetch(`${apiBase}/api/embed`, {
    method: "POST",
    body: formData,
    headers: { "ngrok-skip-browser-warning": "true" },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Embed request failed with status ${response.status}`);
  }
  const { embeddings } = (await response.json()) as { embeddings: number[][] };
  return embeddings;
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
export async function searchByName(query: string, imprint?: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (imprint) params.set("imprint", imprint);
  const response = await fetch(`${apiBase}/api/search-by-name?${params.toString()}`, {
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
