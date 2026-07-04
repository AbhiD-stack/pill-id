"use client";

import { useCallback, useState } from "react";
import {
  predictPill,
  referenceImageSrc,
  type PredictionResult,
} from "@/lib/api";

// Programmatic secure header fetch to cleanly bypass Ngrok's interstitial page
async function fetchSecureImageBlob(url: string): Promise<string> {
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
    return URL.createObjectURL(blob); 
  } catch (error) {
    console.error("Error securing image resource:", error);
    return url; 
  }
}

// ── ADVANCED NORMALIZER: Automatically rotates portrait photos and forces a 2:1 landscape crop ──
function autoCropCenterAndRotate(imageFile: File): Promise<File> {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = URL.createObjectURL(imageFile);
    
    img.onload = () => {
      // Step 1: Detect if the photo is portrait/vertical
      const isPortrait = img.height > img.width;
      
      const normCanvas = document.createElement("canvas");
      const normCtx = normCanvas.getContext("2d");

      const MAX_WIDTH = 1200;
      let scale = 1;

      // Step 2: Normalize orientation to horizontal layout
      if (isPortrait) {
        // If vertical, cap size based on height, then rotate 90 degrees clockwise
        if (img.height > MAX_WIDTH) scale = MAX_WIDTH / img.height;
        normCanvas.width = img.height * scale;
        normCanvas.height = img.width * scale;
        
        normCtx?.translate(normCanvas.width / 2, normCanvas.height / 2);
        normCtx?.rotate((90 * Math.PI) / 180);
        normCtx?.drawImage(img, -(img.width * scale) / 2, -(img.height * scale) / 2, img.width * scale, img.height * scale);
      } else {
        // If already horizontal, just scale normally
        if (img.width > MAX_WIDTH) scale = MAX_WIDTH / img.width;
        normCanvas.width = img.width * scale;
        normCanvas.height = img.height * scale;
        normCtx?.drawImage(img, 0, 0, normCanvas.width, normCanvas.height);
      }

      // Step 3: Extract a clean 2:1 landscape center block (matching IMG_2328 (2).jpg ratio)
      const finalCanvas = document.createElement("canvas");
      const finalCtx = finalCanvas.getContext("2d");

      const cropWidth = normCanvas.width * 0.75; // Take a clear 75% center focus box
      const cropHeight = cropWidth * (512 / 1024); // Force strict 2:1 aspect ratio
      
      const startX = (normCanvas.width - cropWidth) / 2;
      const startY = (normCanvas.height - cropHeight) / 2;

      finalCanvas.width = cropWidth;
      finalCanvas.height = cropHeight;

      if (finalCtx) {
        finalCtx.imageSmoothingEnabled = true;
        finalCtx.imageSmoothingQuality = "high";
        finalCtx.drawImage(
          normCanvas,
          startX,
          startY,
          cropWidth,
          cropHeight,
          0,
          0,
          cropWidth,
          cropHeight
        );
      }
      
      finalCanvas.toBlob((blob) => {
        if (blob) {
          const croppedFile = new File([blob], "optimized_pill.jpg", {
            type: "image/jpeg",
            lastModified: Date.now(),
          });
          resolve(croppedFile);
        } else {
          resolve(imageFile); 
        }
      }, "image/jpeg", 0.90);
    };
    
    img.onerror = () => resolve(imageFile);
  });
}

export function PillIdentifier() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rawResults, setRawResults] = useState<PredictionResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [processingImage, setProcessingImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Intercepts the uploaded file instantly, optimizes it, and prints the result to your screen preview
  const handleFileSelection = useCallback(async (f: File | null) => {
    setError(null);
    setRawResults(null);
    if (!f) {
      setFile(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      return;
    }

    setProcessingImage(true);
    try {
      const optimizedFile = await autoCropCenterAndRotate(f);
      setFile(optimizedFile);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(optimizedFile));
    } catch (err) {
      console.error("Image optimization failure:", err);
      setFile(f);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(f));
    } finally {
      setProcessingImage(false);
    }
  }, [previewUrl]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files?.[0];
      if (f && f.type.startsWith("image/")) handleFileSelection(f);
      else if (f) setError("Please drop an image file (JPG or PNG).");
    },
    [handleFileSelection]
  );

  const onIdentify = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setRawResults(null);
    try {
      // The file state is already perfectly cropped/rotated, send it directly!
      const res = await predictPill(file);
      
      if (res.predictions && res.predictions.length > 0) {
        const securePredictions = await Promise.all(
          res.predictions.map(async (pred) => {
            if (pred.reference_image_url) {
              const fullUrl = referenceImageSrc(pred.reference_image_url);
              const safeBlobUrl = await fetchSecureImageBlob(fullUrl);
              return { ...pred, reference_image_url: safeBlobUrl };
            }
            return pred;
          })
        );
        setRawResults(securePredictions);
      } else {
        setRawResults([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }, [file]);

  const visibleResults = rawResults;

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      {/* Left Column */}
      <section className="lg:col-span-2">
        <div className="lg:sticky lg:top-6">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">
            1 · Upload a medication photo
          </h2>

          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex aspect-square cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed p-4 text-center transition-colors ${
              dragging
                ? "border-sky-400 bg-sky-50"
                : "border-slate-300 bg-white hover:border-sky-300 hover:bg-slate-50"
            }`}
          >
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFileSelection(e.target.files?.[0] ?? null)}
            />
            {previewUrl ? (
              <div className="relative flex h-full w-full items-center justify-center">
                <img
                  src={previewUrl}
                  alt="Selected medication"
                  className="max-h-full max-w-full rounded-xl object-contain shadow-sm"
                />
                {processingImage && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 rounded-xl backdrop-blur-sm">
                    <span className="h-6 w-6 animate-spin rounded-full border-2 border-sky-600 border-t-transparent mb-2" />
                    <p className="text-xs font-semibold text-slate-600">Optimizing Alignment...</p>
                  </div>
                )}
              </div>
            ) : (
              <>
                <svg
                  className="mb-3 h-10 w-10 text-slate-300"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
                  />
                </svg>
                <p className="text-sm font-medium text-slate-700">
                  Click to upload or drag &amp; drop
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  JPG or PNG, up to 15 MB
                </p>
              </>
            )}
          </label>

          {file && !processingImage && (
            <p className="mt-2 truncate text-center text-xs font-mono text-emerald-600 bg-emerald-50 border border-emerald-100 rounded-lg py-1 px-2">
              ✓ Image Horizontally Auto-Aligned
            </p>
          )}

          <button
            onClick={onIdentify}
            disabled={!file || loading || processingImage}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
          >
            {loading && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            )}
            {loading ? "Analyzing Matrix…" : "Identify Medication"}
          </button>

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      </section>

      {/* Right Column */}
      <section className="lg:col-span-3">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">
          2 · Med Recognition App Base Matches{" "}
          <span className="font-normal text-slate-400">
            (visual backbone suggestions)
          </span>
        </h2>
        {loading ? (
          <LoadingState />
        ) : visibleResults ? (
          <ResultsPyramid results={visibleResults} />
        ) : (
          <EmptyState />
        )}
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white/50 p-8 text-center">
      <svg
        className="mb-3 h-10 w-10 text-slate-300"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
        />
      </svg>
      <p className="text-sm font-medium text-slate-500">
        Top visual similarity returns will display here
      </p>
      <p className="mt-1 text-xs text-slate-400">
        Upload a photo and click “Identify Medication”.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3">
      <div className="h-40 animate-pulse rounded-2xl bg-slate-100" />
      <div className="grid grid-cols-2 gap-3">
        <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
        <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="h-20 animate-pulse rounded-2xl bg-slate-100" />
        <div className="h-20 animate-pulse rounded-2xl bg-slate-100" />
      </div>
    </div>
  );
}

function ResultsPyramid({ results }: { results: PredictionResult[] }) {
  const [showExtended, setShowExtended] = useState(false);

  if (results.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
        No visual matches identified by the backbone.
      </div>
    );
  }

  const [first, ...rest] = results;
  const row2 = rest.slice(0, 2); 
  const row3 = rest.slice(2, 4); 
  const row4 = rest.slice(4, 9); 

  return (
    <div className="space-y-3">
      <ResultCard r={first} rank={1} size="lg" />

      {row2.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {row2.map((r, i) => (
            <ResultCard key={`${r.ndc}-${i}`} r={r} rank={i + 2} size="md" />
          ))}
        </div>
      )}

      {row3.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {row3.map((r, i) => (
            <ResultCard key={`${r.ndc}-${i}`} r={r} rank={i + 4} size="sm" />
          ))}
        </div>
      )}

      <div className="pt-2">
        <button
          type="button"
          onClick={() => setShowExtended(!showExtended)}
          className="flex w-full items-center justify-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100"
        >
          {showExtended ? "Hide Extended Matches" : `Reveal Extended Matches (6-10)`}
        </button>
      </div>

      {showExtended && (
        <div className="grid grid-cols-2 gap-3 pt-1 animate-fadeIn">
          {row4.length > 0 ? (
            row4.map((r, i) => (
              <ResultCard key={`${r.ndc || i}-${i}`} r={r} rank={i + 6} size="sm" />
            ))
          ) : (
            <div className="col-span-2 rounded-xl bg-slate-50 p-4 text-center text-xs text-slate-400 border border-dashed border-slate-200">
              The backend model inference limit is currently capped at 5 results.
            </div>
          )}
        </div>
      )}

      <p className="pt-1 text-xs text-slate-400">
        Match score reflects visual similarity to reference images, not a
        confirmed identification.
      </p>
    </div>
  );
}

type CardSize = "lg" | "md" | "sm";

function ResultCard({
  r,
  rank,
  size,
}: {
  r: PredictionResult;
  rank: number;
  size: CardSize;
}) {
  const imgSize = size === "lg" ? "h-24 w-24" : size === "md" ? "h-16 w-16" : "h-12 w-12";
  const nameSize = size === "lg" ? "text-base" : "text-sm";
  const showDetails = size !== "sm"; 
  const isTop = size === "lg";

  return (
    <div className={`flex gap-3 rounded-2xl border bg-white p-3 ${isTop ? "border-sky-200 shadow-sm ring-1 ring-sky-100" : "border-slate-200"}`}>
      <div className="relative shrink-0">
        {r.reference_image_url ? (
          <img
            src={r.reference_image_url}
            alt={`Reference image for ${r.name ?? r.ndc}`}
            className={`${imgSize} rounded-xl border border-slate-200 object-contain`}
          />
        ) : (
          <div className={`${imgSize} flex items-center justify-center rounded-xl border border-dashed border-slate-200 text-[10px] text-slate-400`}>
            no image
          </div>
        )}
        <span className={`absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white ${isTop ? "bg-sky-600" : "bg-slate-400"}`}>
          {rank}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        {isTop && (
          <span className="mb-0.5 inline-block rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">
            Top match
          </span>
        )}

        {r.name ? (
          <>
            <p className={`truncate font-semibold capitalize text-slate-800 ${nameSize}`}>
              {r.name}
            </p>
            <p className="font-mono text-xs text-slate-400">NDC {r.ndc}</p>
          </>
        ) : (
          <>
            <p className={`truncate font-mono font-semibold text-slate-800 ${nameSize}`}>
              {r.ndc}
            </p>
            <p className="text-xs text-slate-400">name unavailable</p>
          </>
        )}

        {showDetails && (r.imprint || r.color) && (
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {r.imprint && (
              <span>
                Imprint <span className="font-medium text-slate-700">{r.imprint}</span>
              </span>
            )}
            {r.imprint && r.color && " · "}
            {r.color && <span className="capitalize">{r.color}</span>}
          </p>
        )}

        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${isTop ? "bg-sky-600" : "bg-sky-400"}`}
              style={{ width: `${Math.min(100, r.score_pct)}%` }}
            />
          </div>
          <span className="w-11 shrink-0 text-right text-xs font-semibold text-slate-600">
            {r.score_pct}%
          </span>
        </div>
      </div>
    </div>
  );
}