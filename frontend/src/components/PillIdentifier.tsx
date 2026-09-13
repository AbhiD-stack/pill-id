"use client";

import { useCallback, useState, useRef, useEffect } from "react";
import ReactCrop, { type Crop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

import {
  predictPill,
  referenceImageSrc,
  type PredictionResult,
} from "@/lib/api";

/** Live in-app camera capture (getUserMedia), so users don't have to leave the
 * app to take a photo in the OS camera and then re-select it from the gallery. */
function LiveCameraCapture({
  onCapture,
  onClose,
}: {
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1280 } } })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch(() => setError("Camera access denied or unavailable. Use \"Select Photo\" instead."));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture(new File([blob], "capture.jpg", { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.95
    );
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-950 p-4 space-y-3">
      {error ? (
        <p className="text-xs text-red-400 text-center py-8">{error}</p>
      ) : (
        <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-lg" />
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={capture}
          disabled={!!error}
          className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 text-white font-bold text-xs rounded-xl"
        >
          ✓ Capture
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-white font-bold text-xs rounded-xl"
        >
          ✕ Cancel
        </button>
      </div>
    </div>
  );
}

// ⚠️ UPDATE THIS WITH YOUR ACTUAL GOOGLE FORM URL
const GOOGLE_FORM_URL = "https://docs.google.com/forms/d/e/.../viewform";

interface TelemetryRun {
  pill_name: string;
  ndc: string;
  confidence: string; // Changed to string to store 10 values
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
  const [lowConfidence, setLowConfidence] = useState(false);
  const [ocrImprintRead, setOcrImprintRead] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showCamera, setShowCamera] = useState(false);

  // ── OPTIONAL BACK-SIDE CAPTURE ──
  // Many pills carry different imprint/score-mark info on each face; capturing
  // both lets the backend average embeddings across sides for a better match.
  const [wantsBackSide, setWantsBackSide] = useState(false);
  const [imgSrcBack, setImgSrcBack] = useState("");
  const imgRefBack = useRef<HTMLImageElement | null>(null);
  const [cropBack, setCropBack] = useState<Crop>();
  const [completedCropBack, setCompletedCropBack] = useState<Crop | null>(null);
  const [rotationBack, setRotationBack] = useState(0);
  const [showCameraBack, setShowCameraBack] = useState(false);

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    // Pilot Intentional Friction Constraint: Small baseline canvas area boundary
    const initialCrop = centerCrop(
      makeAspectCrop({ unit: "%", width: 40 }, 1, width, height),
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

  const cropToFile = (
    image: HTMLImageElement,
    crop: Crop,
    rotationDeg: number
  ): Promise<File | null> => {
    return new Promise((resolve) => {
      // Use a smaller canvas for mobile
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);

      const scaleX = image.naturalWidth / image.width;
      const scaleY = image.naturalHeight / image.height;

      const MAX_DIMENSION = 600; // Even safer for mobile
      const scaleFactor = Math.min(1, MAX_DIMENSION / Math.max(crop.width * scaleX, crop.height * scaleY));

      canvas.width = crop.width * scaleX * scaleFactor;
      canvas.height = crop.height * scaleY * scaleFactor;

      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rotationDeg * Math.PI) / 180);

      ctx.drawImage(
        image,
        crop.x * scaleX,
        crop.y * scaleY,
        crop.width * scaleX,
        crop.height * scaleY,
        -canvas.width / 2,
        -canvas.height / 2,
        canvas.width,
        canvas.height
      );
      ctx.restore();

      canvas.toBlob((blob) => {
        if (!blob) return resolve(null);
        resolve(new File([blob], "normalized.jpg", { type: "image/jpeg" }));
      }, "image/jpeg", 0.9);
    });
  };

  const getCroppedFile = () =>
    imgRef.current && completedCrop ? cropToFile(imgRef.current, completedCrop, rotation) : Promise.resolve(null);

  const getCroppedBackFile = () =>
    imgRefBack.current && completedCropBack
      ? cropToFile(imgRefBack.current, completedCropBack, rotationBack)
      : Promise.resolve(null);

  const onIdentify = useCallback(async () => {
    if (!imgRef.current || !completedCrop) {
      setError("Please frame the pill in the crop area first.");
      return;
    }

    setLoading(true);
    setError(null);
    setRawResults(null);
    setLowConfidence(false);
    setOcrImprintRead(null);

    try {
      const processedFile = await getCroppedFile();
      if (!processedFile) throw new Error("Could not process image. Please try again.");
      const processedBackFile = wantsBackSide ? await getCroppedBackFile() : null;

      const res = await predictPill(processedFile, processedBackFile);
      setLowConfidence(res.low_confidence);
      setOcrImprintRead(res.ocr_imprint_read);

      if (res.predictions && res.predictions.length > 0) {
        const predictions = [...res.predictions];
        
        const securePredictions = await Promise.all(
          predictions.map(async (pred) => {
            if (pred.reference_image_url) {
              const fullUrl = referenceImageSrc(pred.reference_image_url);
              const safeBlobUrl = await fetchSecureImageBlob(fullUrl);
              return { ...pred, reference_image_url: safeBlobUrl };
            }
            return pred;
          })
        );
        
        setRawResults(securePredictions);

        const topMatch = securePredictions[0];
        
        // Captured top 10 matches with name-to-NDC fallback logic
        const newRun: TelemetryRun = {
          pill_name: securePredictions.slice(0, 10).map(p => (p.name && p.name.trim() !== "" ? p.name : `NDC:${p.ndc}`)).join("|"),
          ndc: securePredictions.slice(0, 10).map(p => p.ndc).join("|"),
          confidence: securePredictions.slice(0, 10).map(p => `${p.score_pct}%`).join("|"),
          rotations: rotationCount,
          adjustments: cropAdjustmentCount,
          latency_sec: timeToInference
        };
        
        setStudyBatchLogs((prev) => [...prev, newRun]);
      } else {
        setRawResults([]);
      }
    } catch (e) {
      console.error("Identification Error:", e);
      setError("Analysis failed. Try a smaller crop area.");
    } finally {
      setLoading(false);
    }
  }, [completedCrop, rotation, rotationCount, cropAdjustmentCount, timeToInference, wantsBackSide, completedCropBack, rotationBack]);
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
            <h2 className="mb-3 text-sm font-bold text-slate-700">Step 1: Frame the Medication</h2>
            <p className="mb-4 text-[11px] text-slate-500 leading-relaxed bg-slate-100 p-3 rounded-lg">
              <strong>Pro-Tip:</strong> Crop as tightly as possible around the pill to exclude background. 
  For oblong pills, align them horizontally. If the pill is imprinted with text, orient it so 
  the characters appear upright when you tilt your head to the right.
            </p>
            {!imgSrc ? (
              showCamera ? (
                <LiveCameraCapture
                  onCapture={(f) => { setShowCamera(false); handleFileSelection(f); }}
                  onClose={() => setShowCamera(false)}
                />
              ) : (
                <div className="space-y-2">
                  <label
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                    className={`flex aspect-square cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-4 text-center bg-white transition-all hover:bg-slate-50 border-slate-300 ${dragging ? "border-sky-500 bg-sky-50" : ""}`}
                  >
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => handleFileSelection(e.target.files?.[0] ?? null)} />
                    <p className="font-semibold text-slate-600 text-xs">👉 Tap Here to Select Photo 👈</p>
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowCamera(true)}
                    className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs py-2.5"
                  >
                    📷 Take Photo Now (in-app camera)
                  </button>
                </div>
              )
            ) : (
              // Inside your return block, under "Step 1"
                <div className="rounded-2xl border border-slate-200 bg-slate-950 p-6 flex flex-col items-center"> 
                  {/* Changed p-3 to p-6 for more padding */}
                  
                  {/* Increased max-h-36 to max-h-80 to make the preview area much larger */}
                  <div className="max-h-80 overflow-auto flex items-center justify-center">
                    <ReactCrop crop={crop} onChange={handleCropChange} onComplete={(c) => setCompletedCrop(c)} aspect={1} keepSelection>
                      {/* Increased max-h-32 to max-h-72 for the actual image display */}
                      <img ref={imgRef} alt="Source" src={imgSrc} onLoad={onImageLoad} style={{ transform: `rotate(${rotation}deg)` }} className="max-h-72 object-contain" />
                    </ReactCrop>
                  </div>
                
                {/* Friction Design Metric 2: Microscopic layout touch boundary targets */}
                <div className="mt-6 flex w-full justify-between items-center px-2">
                  {/* Increased text size and padding for better accessibility */}
                  <button type="button" onClick={() => { setRotation((r) => (r + 90) % 360); setRotationCount((c) => c + 1); }} className="text-xs font-bold rounded bg-slate-800 text-slate-200 hover:bg-slate-700 px-4 py-2">
                    Turn 90°
                  </button>
                  <button type="button" onClick={() => handleFileSelection(null)} className="text-xs font-bold rounded bg-slate-800 text-rose-400 hover:bg-slate-700 px-4 py-2">
                    Clear Image
                  </button>
                </div>
              </div>
            )}

            {imgSrc && (
              <div className="mt-4">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wantsBackSide}
                    onChange={(e) => setWantsBackSide(e.target.checked)}
                  />
                  Add a photo of the back of the pill too (recommended — imprints
                  and score marks often differ per side and improve accuracy)
                </label>

                {wantsBackSide && (
                  <div className="mt-3">
                    {!imgSrcBack ? (
                      showCameraBack ? (
                        <LiveCameraCapture
                          onCapture={(f) => {
                            setShowCameraBack(false);
                            const reader = new FileReader();
                            reader.addEventListener("load", () => setImgSrcBack(reader.result?.toString() || ""));
                            reader.readAsDataURL(f);
                          }}
                          onClose={() => setShowCameraBack(false)}
                        />
                      ) : (
                        <div className="space-y-2">
                          <label className="flex aspect-square cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-4 text-center bg-white hover:bg-slate-50 border-slate-300">
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (!f) return;
                                const reader = new FileReader();
                                reader.addEventListener("load", () => setImgSrcBack(reader.result?.toString() || ""));
                                reader.readAsDataURL(f);
                              }}
                            />
                            <p className="font-semibold text-slate-600 text-xs">👉 Select Back-Side Photo 👈</p>
                          </label>
                          <button
                            type="button"
                            onClick={() => setShowCameraBack(true)}
                            className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs py-2.5"
                          >
                            📷 Take Photo Now (in-app camera)
                          </button>
                        </div>
                      )
                    ) : (
                      <div className="rounded-2xl border border-slate-200 bg-slate-950 p-4 flex flex-col items-center">
                        <div className="max-h-60 overflow-auto flex items-center justify-center">
                          <ReactCrop crop={cropBack} onChange={setCropBack} onComplete={(c) => setCompletedCropBack(c)} aspect={1} keepSelection>
                            <img
                              ref={imgRefBack}
                              alt="Back of pill"
                              src={imgSrcBack}
                              onLoad={(e) => {
                                const { width, height } = e.currentTarget;
                                const initial = centerCrop(makeAspectCrop({ unit: "%", width: 40 }, 1, width, height), width, height);
                                setCropBack(initial);
                                setCompletedCropBack(initial);
                              }}
                              style={{ transform: `rotate(${rotationBack}deg)` }}
                              className="max-h-56 object-contain"
                            />
                          </ReactCrop>
                        </div>
                        <div className="mt-4 flex w-full justify-between items-center px-2">
                          <button type="button" onClick={() => setRotationBack((r) => (r + 90) % 360)} className="text-xs font-bold rounded bg-slate-800 text-slate-200 hover:bg-slate-700 px-4 py-2">
                            Turn 90°
                          </button>
                          <button type="button" onClick={() => setImgSrcBack("")} className="text-xs font-bold rounded bg-slate-800 text-rose-400 hover:bg-slate-700 px-4 py-2">
                            Clear Image
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
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
{/* Step 2 Identification Returns Column */}
        <section className="lg:col-span-3 space-y-4">
          <div>
            <h2 className="mb-2 text-sm font-bold text-slate-700">Step 2: Identification Results</h2>
            {loading ? (
              <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
            ) : rawResults ? (
              <>
                {lowConfidence && (
                  <div className="mb-3 rounded-2xl border-l-4 border-red-500 bg-red-50 p-4">
                    <p className="text-sm font-semibold text-red-900">
                      ⚠ Low confidence — none of these candidates strongly match the photo.
                    </p>
                    <p className="text-xs text-red-800 mt-1">
                      Do not act on this result. Retake with better lighting/focus and a tighter
                      crop, or confirm with a pharmacist and the physical packaging.
                    </p>
                  </div>
                )}
                {ocrImprintRead && (
                  <p className="mb-2 text-[11px] text-slate-400">
                    Imprint text read from photo: <span className="font-mono">{ocrImprintRead}</span>
                  </p>
                )}
                <ResultsPyramid
                  results={rawResults}
                  showAll={showAll}
                  setShowAll={setShowAll}
                />
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400">
                Awaiting specimen matrix context injection loop.
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── STEP 3: COMPILATION & SURVEYS ── */}
        {studyBatchLogs.length > 0 && (
          <section className="border border-slate-200 bg-slate-50 rounded-2xl p-5 shadow-sm space-y-4 animate-fadeIn">
            <h3 className="text-sm font-bold text-slate-900">Step 3: Export & Feedback</h3>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              When ready, click the button below to capture the latest data. Then, paste it into your specific survey form.
            </p>

            {/* Combined Compile & Copy Button */}
            <button
              type="button"
              onClick={() => {
                const token = `[PILOT_BATCH|Count:${studyBatchLogs.length}] { ${studyBatchLogs.map((r, i) => 
                  `P${i+1}:${r.pill_name}(${r.ndc})|Conf:[${r.confidence}]|Rot:${r.rotations}|Adj:${r.adjustments}|Lat:${r.latency_sec}s`
                ).join(" // ")} }`;
                
                navigator.clipboard.writeText(token).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className={`w-full py-3 rounded-xl text-xs font-bold transition-all border shadow-sm ${
                copied ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-emerald-700 border-emerald-700 hover:bg-emerald-50"
              }`}
            >
              {copied ? "COPIED TO CLIPBOARD!" : "REFRESH & COPY MASTER TOKEN"}
            </button>

            {/* Instruction Text */}
            <p className="text-[10px] text-slate-400 italic text-center uppercase tracking-wider">
              1. Copy Token ── 2. Open Survey ── 3. Paste Token
            </p>

            {/* Survey Buttons */}
            <div className="grid grid-cols-2 gap-2">
              <a
                href="https://forms.gle/qpxr9YVjVv5XBkAi6"
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] py-3 rounded-xl shadow transition-colors"
              >
                CLINICIANS <span className="text-blue-500">↗</span>
              </a>
              <a
                href="https://forms.gle/3yijMVghFHrDpj7w6"
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[10px] py-3 rounded-xl shadow transition-colors"
              >
                SENIORS <span className="text-blue-500">↗</span>
              </a>
            </div>
          </section>
        )}

    </div>
  );
}

function ResultsPyramid({ results, showAll, setShowAll }: { results: PredictionResult[], showAll: boolean, setShowAll: (s: boolean) => void }) {
  if (!results || results.length === 0) return <div className="text-xs text-slate-400">Zero model returns matches.</div>;

  // The primary logic: Top 5 in the pyramid, 6-10 hidden unless toggled
  const primary = results[0];
  const secondary = results.slice(1, 3);
  const tertiary = results.slice(3, 5);
  const additional = results.slice(5, 10);

  return (
    <div className="space-y-4">
      {/* Primary Result */}
      <ResultCard result={primary} size="large" />

      {/* Secondary Row */}
      <div className="grid grid-cols-2 gap-3">
        {secondary.map((r, i) => <ResultCard key={i} result={r} size="small" />)}
      </div>

      {/* Tertiary Row */}
      <div className="grid grid-cols-2 gap-3">
        {tertiary.map((r, i) => <ResultCard key={i} result={r} size="small" />)}
      </div>

      {/* Reveal Toggle for 6-10 */}
      {results.length > 5 && (
        <div className="pt-2">
          <button 
            onClick={() => setShowAll(!showAll)} 
            className="text-xs font-bold text-sky-600 underline px-1"
          >
            {showAll ? "Hide Results 6-10" : "Show 6-10 Results"}
          </button>
          
          {showAll && additional.length > 0 && (
            <div className="mt-4 space-y-3">
              {additional.map((r, i) => <ResultCard key={i} result={r} size="small" />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultCard({ result, size }: { result: PredictionResult; size: "large" | "small" }) {
  if (!result) return null;
  const isLarge = size === "large";
  
  // Logic: Use name if available, fallback to NDC
  const displayName = result.name && result.name.trim() !== "" ? result.name : `NDC: ${result.ndc}`;
  
  return (
    <div className={`flex gap-3 rounded-2xl border bg-white p-3 border-sky-100 shadow-sm ${isLarge ? "items-center" : ""}`}>
      {result.reference_image_url && (
        <img 
          src={result.reference_image_url} 
          alt={displayName} 
          className={`${isLarge ? "h-20 w-20" : "h-14 w-14"} rounded-xl object-contain shrink-0 border`} 
        />
      )}
      <div className="min-w-0 flex-1">
        <p className={`truncate font-bold text-slate-800 capitalize ${isLarge ? "text-base" : "text-sm"}`}>{displayName}</p>
        <p className="font-mono text-[10px] text-slate-400">NDC {result.ndc}</p>
        <p className="text-[10px] text-slate-500">Imprint: {result.imprint || "N/A"} | Color: {result.color || "N/A"}</p>
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1 flex-1 rounded-full bg-slate-100">
            <div className="h-full bg-sky-600" style={{ width: `${result.score_pct}%` }} />
          </div>
          <span className="w-8 shrink-0 text-right text-[11px] font-semibold text-slate-500">{result.score_pct}%</span>
        </div>
      </div>
    </div>
  );
}