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

const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export async function predictPill(file: File) {
  // Without this, the fetch below falls back to a relative path and hits
  // this app's own server instead of the backend — which comes back as an
  // opaque 404/"Server action not found" response that's hard to diagnose.
  // Fail fast with a message that points at the actual misconfiguration.
  if (!apiBase) {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set, so this app has no backend to call. Set it (e.g. in Vercel Project Settings → Environment Variables) to your backend's URL — such as your Cloudflare Tunnel URL — and redeploy."
    );
  }

  const formData = new FormData();
  formData.append("file", file);

  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/predict`, {
      method: "POST",
      body: formData,
      headers: {
        // This tells Ngrok to shut up and just serve the data instantly!
        "ngrok-skip-browser-warning": "true",
      },
    });
  } catch {
    throw new Error(`Could not reach the backend at ${apiBase}. Make sure it's running and reachable.`);
  }

  if (!response.ok) {
    const text = await response.text();
    // A misconfigured/stale apiBase can still 404 against the right host —
    // that response can be an HTML error page, so avoid dumping raw HTML.
    const looksLikeHtml = text.trim().startsWith("<");
    const detail = !looksLikeHtml && text ? text : `HTTP ${response.status}`;
    throw new Error(`Prediction request failed (calling ${apiBase}): ${detail}`);
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
