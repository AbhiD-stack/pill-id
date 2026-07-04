"use client";

import { useCallback, useState, useRef } from "react";
import ReactCrop, { type Crop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

import {
  predictPill,
  referenceImageSrc,
  type PredictionResult,
} from "@/lib/api";

async function fetchSecureImageBlob(url: string): Promise<string> {
  if (!url) return "";
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!response.ok) throw new Error("Image fetch failed");
    const blob = await response.blob();
    return URL.createObjectURL(blob); 
  } catch (error) {
    console.error("Error securing image resource:", error);
    return url; 
  }
}

export function PillIdentifier() {
  const [imgSrc, setImgSrc] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<Crop | null>(null);
  const [rotation, setRotation] = useState(0);

  const [rawResults, setRawResults] = useState<PredictionResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Automatically center a perfect 1:1 square crop boundary box when an image loads
  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    const initialCrop = centerCrop(
      makeAspectCrop({ unit: "%", width: 80, aspect: 1 }, width, height),
      width,
      height
    );
    setCrop(initialCrop);
    setCompletedCrop(initialCrop);
  }

  const handleFileSelection = useCallback((f: File | null) => {
    setError(null);
    setRawResults(null);
    setRotation(0);
    if (!f) {
      setImgSrc("");
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => setImgSrc(reader.result?.toString() || ""));
    reader.readAsDataURL(f);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("image/")) handleFileSelection(f);
    else if (f) setError("Please drop an image file (JPG or PNG).");
  }, [handleFileSelection]);

  // Creates the final cropped file payload on demand when hitting submit
  const getCroppedFile = (): Promise<File | null> => {
    return new Promise((resolve) => {
      if (!imgRef.current || !completedCrop) return resolve(null);

      const image = imgRef.current;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);

      // Extract pixel scales safely
      const scaleX = image.naturalWidth / image.width;
      const scaleY = image.naturalHeight / image.height;

      // Force high-quality target pixel square matrix dimensions (e.g., 512x512 standard)
      const targetSize = 512;
      canvas.width = targetSize;
      canvas.height = targetSize;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      // Move canvas matrix to center point to apply rotation neatly
      ctx.translate(targetSize / 2, targetSize / 2);
      ctx.rotate((rotation * Math.PI) / 180);

      // Map selection space cleanly back onto original image space coordinates
      ctx.drawImage(
        image,
        completedCrop.x * scaleX,
        completedCrop.y * scaleY,
        completedCrop.width * scaleX,
        completedCrop.height * scaleY,
        -targetSize / 2,
        -targetSize / 2,
        targetSize,
        targetSize
      );

      canvas.toBlob((blob) => {
        if (!blob) return resolve(null);
        resolve(new File([blob], "normalized_pill.jpg", { type: "image/jpeg" }));
      }, "image/jpeg", 0.95);
    });
  };

  const onIdentify = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRawResults(null);
    try {
      const processedFile = await getCroppedFile();
      if (!processedFile) {
        throw new Error("Please select and crop a region containing the pill first.");
      }

      const res = await predictPill(processedFile);
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
  }, [completedCrop, rotation]);

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      {/* Left Column */}
      <section className="lg:col-span-2">
        <div className="lg:sticky lg:top-6">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">
            1 · Upload &amp; Align Pill Frame
          </h2>

          {!imgSrc ? (
            <label
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex aspect-square cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed p-4 text-center transition-colors ${
                dragging ? "border-sky-400 bg-sky-50" : "border-slate-300 bg-white hover:border-sky-300 hover:bg-slate-50"
              }`}
            >
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handleFileSelection(e.target.files?.[0] ?? null)}
              />
              <svg className="mb-3 h-10 w-10 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
              <p className="text-sm font-medium text-slate-700">Click to upload or drag &amp; drop</p>
              <p className="mt-1 text-xs text-slate-400">JPG or PNG, up to 15 MB</p>
            </label>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-slate-950 p-4 shadow-inner flex flex-col items-center">
              <div className="max-h-80 overflow-auto flex items-center justify-center">
                <ReactCrop
                  crop={crop}
                  onChange={(c) => setCrop(c)}
                  onComplete={(c) => setCompletedCrop(c)}
                  aspect={1}
                  keepSelection
                >
                  <img
                    ref={imgRef}
                    alt="Source upload asset"
                    src={imgSrc}
                    onLoad={onImageLoad}
                    style={{ transform: `rotate(${rotation}deg)`, transition: "transform 0.15s ease" }}
                    className="max-h-72 object-contain"
                  />
                </ReactCrop>
              </div>

              <div className="mt-4 flex w-full gap-2">
                <button
                  type="button"
                  onClick={() => setRotation((r) => (r + 90) % 360)}
                  className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-800"
                >
                  Rotate 90°
                </button>
                <button
                  type="button"
                  onClick={() => handleFileSelection(null)}
                  className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-rose-400 transition-colors hover:bg-slate-800"
                >
                  Clear Image
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-400 text-center">
                Drag corners to frame the pill perfectly inside the square box context.
              </p>
            </div>
          )}

          <button
            onClick={onIdentify}
            disabled={!imgSrc || loading}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
          >
            {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
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
          2 · Med Recognition App Base Matches <span className="font-normal text-slate-400">(visual backbone suggestions)</span>
        </h2>
        {loading ? <LoadingState /> : rawResults ? <ResultsPyramid results={rawResults} /> : <EmptyState />}
      </section>
    </div>
  );
}

function EmptyState() { return ( <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white/50 p-8 text-center"> <svg className="mb-3 h-10 w-10 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}> <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /> </svg> <p className="text-sm font-medium text-slate-500">Top visual similarity returns will display here</p> <p className="mt-1 text-xs text-slate-400">Upload a photo and click “Identify Medication”.</p> </div> ); }
function LoadingState() { return ( <div className="space-y-3"> <div className="h-40 animate-pulse rounded-2xl bg-slate-100" /> <div className="grid grid-cols-2 gap-3"> <div className="h-24 animate-pulse rounded-2xl bg-slate-100" /> <div className="h-24 animate-pulse rounded-2xl bg-slate-100" /> </div> </div> ); }
function ResultsPyramid({ results }: { results: PredictionResult[] }) { const [showExtended, setShowExtended] = useState(false); if (results.length === 0) return <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">No visual matches identified by the backbone.</div>; const [first, ...rest] = results; const row2 = rest.slice(0, 2); const row3 = rest.slice(2, 4); const row4 = rest.slice(4, 9); return ( <div className="space-y-3"> <ResultCard r={first} rank={1} size="lg" /> {row2.length > 0 && ( <div className="grid grid-cols-2 gap-3">{row2.map((r, i) => ( <ResultCard key={`${r.ndc}-${i}`} r={r} rank={i + 2} size="md" /> ))}</div> )} {row3.length > 0 && ( <div className="grid grid-cols-2 gap-3">{row3.map((r, i) => ( <ResultCard key={`${r.ndc}-${i}`} r={r} rank={i + 4} size="sm" /> ))}</div> )} <div className="pt-2"> <button type="button" onClick={() => setShowExtended(!showExtended)} className="flex w-full items-center justify-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100"> {showExtended ? "Hide Extended Matches" : `Reveal Extended Matches (6-10)`} </button> </div> {showExtended && ( <div className="grid grid-cols-2 gap-3 pt-1 animate-fadeIn"> {row4.length > 0 ? row4.map((r, i) => <ResultCard key={i} r={r} rank={i + 6} size="sm" />) : <div className="col-span-2 rounded-xl bg-slate-50 p-4 text-center text-xs text-slate-400 border border-dashed border-slate-200">The backend model inference limit is capped at 5.</div>} </div> )} </div> ); }
function ResultCard({ r, rank, size }: { r: PredictionResult; rank: number; size: "lg" | "md" | "sm" }) { const imgSize = size === "lg" ? "h-24 w-24" : size === "md" ? "h-16 w-16" : "h-12 w-12"; const nameSize = size === "lg" ? "text-base" : "text-sm"; return ( <div className={`flex gap-3 rounded-2xl border bg-white p-3 ${size === "lg" ? "border-sky-200 shadow-sm ring-1 ring-sky-100" : "border-slate-200"}`}> <div className="relative shrink-0"> {r.reference_image_url ? <img src={r.reference_image_url} alt="" className={`${imgSize} rounded-xl border border-slate-200 object-contain`} /> : <div className={`${imgSize} flex items-center justify-center rounded-xl border border-dashed border-slate-200 text-[10px] text-slate-400`}>no image</div>} <span className="absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white bg-slate-400">{rank}</span> </div> <div className="min-w-0 flex-1"> {size === "lg" && <span className="mb-0.5 inline-block rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">Top match</span>} <p className={`truncate font-semibold capitalize text-slate-800 ${nameSize}`}>{r.name || r.ndc}</p> <p className="font-mono text-xs text-slate-400">NDC {r.ndc}</p> <div className="mt-1.5 flex items-center gap-2"> <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-sky-600" style={{ width: `${r.score_pct}%` }} /></div> <span className="w-11 shrink-0 text-right text-xs font-semibold text-slate-600">{r.score_pct}%</span> </div> </div> </div> ); }