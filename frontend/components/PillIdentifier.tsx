"use client";

import { useCallback, useState, useRef } from "react";
import ReactCrop, { type Crop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

import {
  predictPill,
  referenceImageSrc,
  type PredictionResult,
} from "@/lib/api";

// ⚠️ UPDATE THIS WITH YOUR ACTUAL GOOGLE FORM URL
const GOOGLE_FORM_URL = "https://docs.google.com/forms/d/e/.../viewform";

interface TelemetryRun {
  pill_name: string;
  ndc: string;
  confidence: number;
  rotations: number;
  adjustments: number;
  latency_sec: number;
}

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
  const [showAll, setShowAll] = useState(false);
  const [imgSrc, setImgSrc] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<Crop | null>(null);
  const [rotation, setRotation] = useState(0);

  // ── ACTIVE SINGLE RUN TELEMETRY CHANNELS ──
  const [rotationCount, setRotationCount] = useState(0);
  const [cropAdjustmentCount, setCropAdjustmentCount] = useState(0);
  const [timeToInference, setTimeToInference] = useState<number>(0);
  const timerRef = useRef<number | null>(null);
  const isTrackingAdjustment = useRef(false);

  // ── MASTER BATCH STUDY LOG STATE ──
  const [studyBatchLogs, setStudyBatchLogs] = useState<TelemetryRun[]>([]);
  const [generatedToken, setGeneratedToken] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const [rawResults, setRawResults] = useState<PredictionResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    // Pilot Intentional Friction Constraint: Small baseline canvas area boundary
    const initialCrop = centerCrop(
      makeAspectCrop({ unit: "%", width: 40, aspect: 1 }, width, height),
      width,
      height
    );
    setCrop(initialCrop);
    setCompletedCrop(initialCrop);
    
    setTimeToInference(0);
    if (timerRef.current) clearInterval(timerRef.current);
    const startTime = Date.now();
    timerRef.current = window.setInterval(() => {
      setTimeToInference(Math.round((Date.now() - startTime) / 1000));
    }, 1000);
  }

  const handleFileSelection = useCallback((f: File | null) => {
    setError(null);
    setRawResults(null);
    setRotation(0);
    setRotationCount(0);
    setCropAdjustmentCount(0);
    setTimeToInference(0);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
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
  }, [handleFileSelection]);

  const handleCropChange = (newCrop: Crop) => {
    setCrop(newCrop);
    if (!isTrackingAdjustment.current) {
      isTrackingAdjustment.current = true;
      setCropAdjustmentCount((c) => c + 1);
      setTimeout(() => { isTrackingAdjustment.current = false; }, 400);
    }
  };

  const getCroppedFile = (): Promise<File | null> => {
    return new Promise((resolve) => {
      if (!imgRef.current || !completedCrop) return resolve(null);
      const image = imgRef.current;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);

      const scaleX = image.naturalWidth / image.width;
      const scaleY = image.naturalHeight / image.height;
      const targetSize = 512;
      
      canvas.width = targetSize;
      canvas.height = targetSize;
      ctx.imageSmoothingEnabled = true;

      ctx.translate(targetSize / 2, targetSize / 2);
      ctx.rotate((rotation * Math.PI) / 180);

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
        resolve(new File([blob], "normalized.jpg", { type: "image/jpeg" }));
      }, "image/jpeg", 0.95);
    });
  };

  const onIdentify = useCallback(async () => {
    if (!imgRef.current || !completedCrop) return; // Add this check      clearInterval(timerRef.current);
      
    setLoading(true);
    setError(null);
    setRawResults(null);
    
    try {
      const processedFile = await getCroppedFile();
      if (!processedFile) throw new Error("Frame the medication correctly.");

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

        // Commit single run data to the master batch tracking matrix array
        // Update this block inside onIdentify:
        const topMatch = securePredictions[0];
        const newRun: TelemetryRun = {
          pill_name: securePredictions.slice(0, 10).map(p => p.name).join("|"),
          ndc: securePredictions.slice(0, 10).map(p => p.ndc).join("|"),
          confidence: topMatch.score_pct, // Kept as primary confidence
          rotations: rotationCount,
          adjustments: cropAdjustmentCount,
          latency_sec: timeToInference
        };
        setStudyBatchLogs((prev) => [...prev, newRun]);
        setGeneratedToken(""); // Force calculation refresh on new entries
      } else {
        setRawResults([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis error occurred.");
    } finally {
      setLoading(false);
    }
  }, [completedCrop, rotation, rotationCount, cropAdjustmentCount, timeToInference]);

  // Master Token Compilation Action Loop
  const handleCompileMasterToken = () => {
    if (studyBatchLogs.length === 0) return;
    
    const tokenHeader = `[PILOT_BATCH_STUDY | Count:${studyBatchLogs.length}]`;
    const tokenBody = studyBatchLogs.map((run, i) => (
      `P${i+1}:${run.pill_name}(${run.ndc})|Conf:${run.confidence}%|Rot:${run.rotations}|Adj:${run.adjustments}|Lat:${run.latency_sec}s`
    )).join(" // ");
    
    setGeneratedToken(`${tokenHeader} { ${tokenBody} }`);
    setCopied(false);
  };

  const handleCopyClipboard = () => {
    if (!generatedToken) return;
    navigator.clipboard.writeText(generatedToken).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-6">
      
      {/* Pilot Phase Header Marker */}
      <div className="p-3 bg-slate-900 border border-slate-800 text-slate-300 rounded-2xl flex items-center justify-between">
        <span className="text-xs font-bold font-mono tracking-wider text-sky-400">🔬 PILOT DATA PORTAL ACTIVE</span>
        <span className="text-xs font-bold text-slate-400 bg-slate-800 px-3 py-1 rounded-lg">
          Batch Count: {studyBatchLogs.length} Pills Evaluated
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        
        {/* Step 1 Workspace Column */}
        <section className="lg:col-span-2">
          <div className="lg:sticky lg:top-6">
            <h2 className="mb-3 text-sm font-bold text-slate-700">Step 1: Put Pill Picture Here</h2>

            {!imgSrc ? (
              <label
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={`flex aspect-square cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-4 text-center bg-white transition-all hover:bg-slate-50 border-slate-300 ${dragging ? "border-sky-500 bg-sky-50" : ""}`}
              >
                <input type="file" accept="image/*" className="hidden" onChange={(e) => handleFileSelection(e.target.files?.[0] ?? null)} />
                <p className="font-semibold text-slate-600 text-xs">👉 Tap Here to Select Photo 👈</p>
              </label>
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-950 p-3 flex flex-col items-center">
                {/* Friction Design Metric 1: Small constrained canvas height footprint */}
                <div className="max-h-36 overflow-auto flex items-center justify-center">
                  <ReactCrop crop={crop} onChange={handleCropChange} onComplete={(c) => setCompletedCrop(c)} aspect={1} keepSelection>
                    <img ref={imgRef} alt="Source" src={imgSrc} onLoad={onImageLoad} style={{ transform: `rotate(${rotation}deg)` }} className="max-h-32 object-contain" />
                  </ReactCrop>
                </div>
                
                {/* Friction Design Metric 2: Microscopic layout touch boundary targets */}
                <div className="mt-3 flex w-full justify-between items-center px-1">
                  <button type="button" onClick={() => { setRotation((r) => (r + 90) % 360); setRotationCount((c) => c + 1); }} className="text-[9px] font-bold rounded bg-slate-800 text-slate-200 hover:bg-slate-700 px-1.5 py-0.5">
                    Turn 90°
                  </button>
                  <button type="button" onClick={() => handleFileSelection(null)} className="text-[9px] font-bold rounded bg-slate-800 text-rose-400 hover:bg-slate-700 px-1.5 py-0.5">
                    Clear Image
                  </button>
                </div>
              </div>
            )}

            <button
              onClick={onIdentify}
              disabled={!imgSrc || loading}
              className="mt-4 w-full rounded-xl font-bold text-white shadow-md transition-all disabled:bg-slate-200 disabled:shadow-none bg-sky-600 hover:bg-sky-700 py-3 text-sm"
            >
              {loading ? "Analyzing Specimen..." : "Check This Pill"}
            </button>
            {error && <div className="mt-3 rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</div>}
          </div>
        </section>

        {/* Step 2 Identification Returns Column */}
        {/* Update this part of your return block */}
<section className="lg:col-span-3 space-y-6"> {/* Increased from space-y-4 to space-y-6 */}
  <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm"> {/* Added background and padding to the whole section */}
    <h2 className="mb-4 text-lg font-bold text-slate-800">Step 2: Identification Results</h2> {/* Increased text size */}
            {loading ? (
              <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
            ) : rawResults ? (
              <ResultsPyramid 
                results={rawResults} 
                showAll={showAll} 
                setShowAll={setShowAll} 
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400">
                Awaiting specimen matrix context injection loop.
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── MASTER DATA COMPILATION TERMINAL AREA ── */}
      {studyBatchLogs.length > 0 && (
        <section className="border border-emerald-200 bg-emerald-50/20 rounded-2xl p-5 shadow-sm space-y-4 animate-fadeIn">
          <div>
            <h3 className="text-sm font-bold text-emerald-900">Step 3: End of Session Report Compiler</h3>
            <p className="text-xs text-slate-600 mt-1 leading-relaxed">
              When you have finished testing your assignment group of pills, click the green compilation button below. This transforms all individual test records into an analytical block to paste into Question 1 on your study questionnaire.
            </p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCompileMasterToken}
              className="px-5 py-3 rounded-xl bg-emerald-700 text-white font-bold text-xs hover:bg-emerald-800 transition-all shadow-sm shrink-0"
            >
              🛠️ Generate Master Study Token
            </button>
            
            {generatedToken && (
              <button
                type="button"
                onClick={handleCopyClipboard}
                className={`flex-1 py-3 px-4 rounded-xl text-xs font-bold transition-all border shadow-sm flex items-center justify-center gap-1 ${
                  copied ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                }`}
              >
                {copied ? "✓ Copied to Clipboard!" : "📋 Copy Token Text"}
              </button>
            )}
          </div>

          {generatedToken && (
            <div className="space-y-3 animate-fadeIn">
              <div className="bg-slate-900 rounded-xl p-3 font-mono text-[10px] text-slate-300 max-h-24 overflow-y-auto border border-slate-800 leading-relaxed shadow-inner select-all">
                {generatedToken}
              </div>
              <div className="text-center pt-1">
                <a
                  href={GOOGLE_FORM_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 bg-sky-600 hover:bg-sky-700 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow transition-colors"
                >
                  🚀 Open Final Verification Form Suite ↗
                </a>
              </div>
            </div>
          )}
        </section>
      )}

    </div>
  );
}

function ResultsPyramid({ results, showAll, setShowAll }: { results: PredictionResult[], showAll: boolean, setShowAll: (s: boolean) => void }) {
  if (results.length === 0) return <div className="text-xs text-slate-400">Zero model returns matches.</div>;
  
  const displayResults = showAll ? results : results.slice(0, 5);

  // Inside ResultsPyramid function
return (
  <div className="space-y-4"> {/* Increased from space-y-3 to space-y-4 */}
    {displayResults.map((r, i) => (
      <div key={i} className="flex gap-4 rounded-2xl border bg-white p-4 border-sky-100 shadow-md"> {/* Increased p-3 to p-4 and gap-3 to gap-4 */}
        {r.reference_image_url && <img src={r.reference_image_url} alt="" className="h-20 w-20 rounded-xl object-contain shrink-0 border" />} {/* Increased size from h-14 w-14 to h-20 w-20 */}
        <div className="min-w-0 flex-1 py-1"> {/* Added py-1 to align content better */}
          <p className="truncate font-bold text-slate-800 capitalize text-base">{r.name || r.ndc}</p> {/* Increased text-sm to text-base */}
          
          <div className="flex gap-2 font-mono text-[10px] text-slate-500">
              <span>NDC: {r.ndc}</span>
              {r.imprint && <span>• Imprint: {r.imprint}</span>}
              {r.color && <span>• Color: {r.color}</span>}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1 flex-1 rounded-full bg-slate-100">
                <div className="h-full bg-sky-600" style={{ width: `${r.score_pct}%` }} />
              </div>
              <span className="w-8 shrink-0 text-right text-[11px] font-semibold text-slate-500">{r.score_pct}%</span>
            </div>
          </div>
        </div>
      ))}
      <button onClick={() => setShowAll(!showAll)} className="text-xs font-bold text-sky-600 underline px-1">
        {showAll ? "Show Top 5" : "Show 6-10 Results"}
      </button>
    </div>
  );
}