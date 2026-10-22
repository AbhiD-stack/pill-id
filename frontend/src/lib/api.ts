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
  // User-typed imprint only: false = no pill in the database carries it.
  imprint_found?: boolean | null;
  // One embedding per uploaded side (front, then back). Stored with a pill
  // saved to "My Pills" and compared against future scans on-device. Absent
  // from older backends.
  query_embeddings?: number[][];
  query_cohort?: number[][];
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
  custom?: boolean; // typed in by the user, not from the FDA list
};

// A random id for this browser, so the server's per-minute scan allowance
// is per device (many users can arrive from the same address through a
// tunnel). Not tied to the person; nothing else is stored with it.
let _deviceId: string | null = null;
function deviceId(): string {
  if (_deviceId) return _deviceId;
  try {
    _deviceId = localStorage.getItem("pillid.deviceId");
    if (!_deviceId) {
      _deviceId = crypto.randomUUID();
      localStorage.setItem("pillid.deviceId", _deviceId);
    }
  } catch {
    _deviceId ??= crypto.randomUUID();
  }
  return _deviceId;
}

const apiBase = process.env.NEXT_PUBLIC_SAME_ORIGIN
  ? "" // served by the backend itself (npm run build:static)
  : (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

/** Color(s) and shape the user confirmed, in the FDA's words. */
export interface PillLook {
  colors: string[];
  shape: string | null;
}

// A readable error for the person using the app (the server's own message
// when it sent one, never raw HTML/JSON).
// Plain-language message for a failed request. A TypeError means the browser
// never got an answer: no internet, the server is off, or the browser
// blocked the request (Chrome asks before a website may reach a device on
// your own network, which is where the Pill ID server runs).
export const CANT_REACH =
  "Can't reach the Pill ID server. Check your internet connection. If your browser asked about \"local network access\", choose Allow (address bar icon > Site settings > Local network access), then reload.";
export function errorMessage(err: unknown): string {
  if (err instanceof TypeError) return CANT_REACH;
  return err instanceof Error ? err.message : String(err);
}

async function apiError(response: Response, what: string): Promise<Error> {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const body = JSON.parse(text);
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      if (!text.trimStart().startsWith("<")) detail = text.slice(0, 200);
    }
  } catch {
    // body unreadable
  }
  if (response.status === 429) return new Error(detail || "Too many requests. Please wait a moment and try again.");
  if (response.status === 503 && detail) return new Error(detail.replace(/;.*$/, ".").replace(/\.?$/, ". Try again in a minute."));
  if (response.status >= 500) return new Error(`The server had a problem (${what}). Please try again in a moment.`);
  return new Error(detail || `${what} failed (error ${response.status}).`);
}

export async function predictPill(
  file: File,
  fileBack?: File | null,
  rxOrOtc?: RxOrOtc,
  imprint?: string | null,
  look?: PillLook | null
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
  // Color/shape the user confirmed (never unconfirmed camera guesses).
  if (look?.colors.length) formData.append("colors", look.colors.join(","));
  if (look?.shape) formData.append("shape", look.shape);

  const response = await fetch(`${apiBase}/api/predict`, {
    method: "POST",
    body: formData,
    headers: {
      // This tells Ngrok to shut up and just serve the data instantly!
      "ngrok-skip-browser-warning": "true", "X-Device-Id": deviceId(),
    },
  });

  if (!response.ok) {
    throw await apiError(response, "Prediction");
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
    headers: { "ngrok-skip-browser-warning": "true", "X-Device-Id": deviceId() },
  });
  if (!response.ok) {
    throw await apiError(response, "Feedback");
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
        "ngrok-skip-browser-warning": "true", "X-Device-Id": deviceId(),
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
  imprintFound: boolean | null;
  queryEmbeddings: number[][] | null;
  queryCohort: number[][] | null;
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
  imprint?: string | null,
  look?: PillLook | null
): Promise<IdentifyResult> {
  const file = await canvasToFile(canvas);
  const fileBack = backCanvas ? await canvasToFile(backCanvas) : null;
  const { prediction_id, predictions, low_confidence, ocr_imprint_read, imprint_source, imprint_found, query_embeddings, query_cohort } =
    await predictPill(file, fileBack, null, imprint, look);

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
      // Only real pill photos are shown (package photos are replaced by a drawing).
      reference_image_url: p.reference_image_url && p.reference_image_kind === "pill_photo"
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
    imprintFound: imprint_found ?? null,
    queryEmbeddings: query_embeddings && query_embeddings.length > 0 ? query_embeddings : null,
    queryCohort: query_cohort && query_cohort.length > 0 ? query_cohort : null,
  };
}

// The imprint on each side as read from the photos -- a suggestion for the
// user to confirm or correct before matching.
export async function readImprint(
  front: HTMLCanvasElement,
  back?: HTMLCanvasElement | null
): Promise<{ side_1: string; side_2: string; source: "vision" | "ocr"; colors?: string[]; shape?: string | null }> {
  const formData = new FormData();
  formData.append("file", await canvasToFile(front));
  if (back) formData.append("file_back", await canvasToFile(back));
  const response = await fetch(`${apiBase}/api/read-imprint`, {
    method: "POST",
    body: formData,
    headers: { "ngrok-skip-browser-warning": "true", "X-Device-Id": deviceId() },
  });
  if (!response.ok) {
    throw await apiError(response, "Imprint read");
  }
  return response.json();
}

// Embeddings of a fresh photo (front, and back if taken) -- used to check a
// pill against the patient's own saved medicines.
export type Embedded = { embeddings: number[][]; cohort: number[][] | null };

export async function embedCanvases(front: HTMLCanvasElement, back?: HTMLCanvasElement | null): Promise<Embedded> {
  const formData = new FormData();
  formData.append("file", await canvasToFile(front));
  if (back) formData.append("file_back", await canvasToFile(back));
  const response = await fetch(`${apiBase}/api/embed`, {
    method: "POST",
    body: formData,
    headers: { "ngrok-skip-browser-warning": "true", "X-Device-Id": deviceId() },
  });
  if (!response.ok) throw await apiError(response, "Checking the pill");
  const data = (await response.json()) as { embeddings: number[][]; cohort?: number[][] };
  return { embeddings: data.embeddings, cohort: data.cohort ?? null };
}

// Cohort statistics for embeddings saved before the app used them.
export async function fetchCohort(embeddings: number[][]): Promise<number[][]> {
  const response = await fetch(`${apiBase}/api/cohort`, {
    method: "POST",
    body: JSON.stringify({ embeddings }),
    headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true", "X-Device-Id": deviceId() },
  });
  if (!response.ok) throw await apiError(response, "Preparing saved pills");
  return ((await response.json()) as { cohort: number[][] }).cohort;
}

// Share a medicine's pill photo (no name or other personal info) so the app
// can recognize that pill for everyone. The server checks it against the
// FDA record before using it.
export async function contributePhoto(
  front: HTMLCanvasElement,
  back: HTMLCanvasElement | null,
  label: string
): Promise<{ accepted: boolean; reason: string }> {
  const formData = new FormData();
  formData.append("file", await canvasToFile(front));
  if (back) formData.append("file_back", await canvasToFile(back));
  formData.append("label", label);
  const response = await fetch(`${apiBase}/api/contribute`, {
    method: "POST",
    body: formData,
    headers: { "ngrok-skip-browser-warning": "true", "X-Device-Id": deviceId() },
  });
  if (!response.ok) throw await apiError(response, "Sharing the photo");
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
    headers: { "ngrok-skip-browser-warning": "true", "X-Device-Id": deviceId() },
  });
  if (!response.ok) {
    throw await apiError(response, "Embed");
  }
  const { embeddings } = (await response.json()) as { embeddings: number[][] };
  return embeddings;
}

async function _resolveSearchResultImages(results: SearchResult[]): Promise<SearchResult[]> {
  return Promise.all(
    results.map(async (r) => ({
      ...r,
      reference_image_url: r.reference_image_url && r.reference_image_kind === "pill_photo"
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
    headers: { "ngrok-skip-browser-warning": "true", "X-Device-Id": deviceId() },
  });
  if (!response.ok) {
    throw await apiError(response, "Search");
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
    headers: { "ngrok-skip-browser-warning": "true", "X-Device-Id": deviceId() },
  });
  if (!response.ok) {
    throw await apiError(response, "Search");
  }
  const { results } = (await response.json()) as { results: SearchResult[] };
  return _resolveSearchResultImages(results);
}
