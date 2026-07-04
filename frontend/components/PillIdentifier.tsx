"use client";

import { useCallback, useState, useRef } from "react";
import ReactCrop, { type Crop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

import {
  predictPill,
  referenceImageSrc,
  type PredictionResult,
} from "@/lib/api";

const GOOGLE_FORM_URL = "https://docs.google.com/forms/d/e/.../viewform";

interface TelemetryRun {
  pill_name: string;
  ndc: string;
  confidence: number;
  user_verification: "CONFIRMED" | "DISPUTED" | "PENDING";
  rotations: number;
  adjustments: number;
  latency_sec: number;
}

async function fetchSecureImageBlob(url: string): Promise<string> {
  if (!url) return "";
  try {
    const response = await fetch(url, { method: "GET", headers: { "ngrok-skip-browser-warning": "true" } });
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

  const [rotationCount, setRotationCount] = useState(0);
  const [cropAdjustmentCount, setCropAdjustmentCount] = useState(0);
  const [timeToInference, setTimeToInference] = useState<number>(0);
  const timerRef = useRef<number | null>(null);
  const isTrackingAdjustment = useRef(false);

  const [studyBatchLogs, setStudyBatchLogs] = useState<TelemetryRun[]>([]);
  const [generatedToken, setGeneratedToken] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const [rawResults, setRawResults] = useState<PredictionResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    // 80% Canvas Constraint as per study requirement
    const initialCrop = centerCrop(
      makeAspectCrop({ unit: "%", width: 80, aspect: 1 }, width, height),
      width, height
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
    setError(null); setRawResults(null); setRotation(0); setRotationCount(0);
    setCropAdjustmentCount(0); setTimeToInference(0);
    if (!f) { setImgSrc(""); return; }
    const reader = new FileReader();
    reader.addEventListener("load", () => setImgSrc(reader.result?.toString() || ""));
    reader.readAsDataURL(f);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
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

  const onIdentify = useCallback(async () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setLoading(true); setError(null);
    try {
      if (!imgRef.current || !completedCrop) throw new Error("Frame the medication.");
      // Normalization logic remains identical
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const scaleX = imgRef.current.naturalWidth / imgRef.current.width;
      const scaleY = imgRef.current.naturalHeight / imgRef.current.height;
      canvas.width = 512; canvas.height = 512;
      ctx?.translate(256, 256); ctx?.rotate((rotation * Math.PI) / 180);
      ctx?.drawImage(imgRef.current, completedCrop.x * scaleX, completedCrop.y * scaleY, completedCrop.width * scaleX, completedCrop.height * scaleY, -256, -256, 512, 512);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
      const file = new File([blob!], "norm.jpg", { type: "image/jpeg" });

      const res = await predictPill(file);
      const secure = await Promise.all(res.predictions.slice(0, 10).map(async (p) => ({
        ...p, reference_image_url: p.reference_image_url ? await fetchSecureImageBlob(referenceImageSrc(p.reference_image_url)) : ""
      })));
      
      setRawResults(secure);
      setStudyBatchLogs(prev => [...prev, {
        pill_name: secure[0].name, ndc: secure[0].ndc, confidence: secure[0].score_pct,
        user_verification: "PENDING", rotations: rotationCount, adjustments: cropAdjustmentCount, latency_sec: timeToInference
      }]);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, [completedCrop, rotation, rotationCount, cropAdjustmentCount, timeToInference]);

  const handleVerification = (status: "CONFIRMED" | "DISPUTED") => {
    setStudyBatchLogs(prev => {
      const updated = [...prev];
      updated[updated.length - 1].user_verification = status;
      return updated;
    });
    setRawResults(null);
  };

  const handleCompile = () => {
    const token = `[STUDY_BATCH|Count:${studyBatchLogs.length}] { ${studyBatchLogs.map(r => 
      `${r.pill_name}|Conf:${r.confidence}%|Ver:${r.user_verification}|Rot:${r.rotations}|Adj:${r.adjustments}|Lat:${r.latency_sec}s`
    ).join(" // ")} }`;
    setGeneratedToken(token);
    navigator.clipboard.writeText(token).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div className="grid lg:grid-cols-2 gap-8">
        <section>
          <h2 className="text-sm font-bold text-slate-500 uppercase">Step 1: Frame & Identify</h2>
          {!imgSrc ? (
            <label onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDrop={onDrop} className={`flex aspect-square border-4 border-dashed rounded-3xl items-center justify-center cursor-pointer ${dragging ? "border-sky-500 bg-sky-50" : "border-slate-300"}`}>
              <input type="file" accept="image/*" className="hidden" onChange={(e) => handleFileSelection(e.target.files?.[0] ?? null)} />
              <p className="font-bold text-slate-500">Tap to Select Pill Image</p>
            </label>
          ) : (
            <div className="border-4 border-slate-900 rounded-3xl p-4 bg-slate-950">
              <ReactCrop crop={crop} onChange={handleCropChange} onComplete={c => setCompletedCrop(c)} aspect={1}>
                <img ref={imgRef} src={imgSrc} onLoad={onImageLoad} style={{ transform: `rotate(${rotation}deg)` }} className="max-h-96" />
              </ReactCrop>
              <div className="flex gap-2 mt-4">
                <button onClick={() => { setRotation(r => (r + 90) % 360); setRotationCount(c => c + 1); }} className="flex-1 py-3 bg-slate-800 text-white font-bold rounded-xl text-xs">Rotate 90°</button>
                <button onClick={onIdentify} className="flex-[2] py-3 bg-sky-600 text-white font-bold rounded-xl text-xs">Check Pill</button>
              </div>
            </div>
          )}
        </section>

        <section>
          <h2 className="text-sm font-bold text-slate-500 uppercase">Step 2: Verification Quiz</h2>
          {rawResults ? (
            <div className="space-y-4">
              <div className="text-sm font-bold">Model Top Pick: {rawResults[0].name} ({rawResults[0].score_pct}%)</div>
              <div className="flex gap-2">
                <button onClick={() => handleVerification("CONFIRMED")} className="flex-1 py-4 bg-emerald-600 text-white font-bold rounded-2xl">Confirm Correct</button>
                <button onClick={() => handleVerification("DISPUTED")} className="flex-1 py-4 bg-rose-600 text-white font-bold rounded-2xl">Dispute Prediction</button>
              </div>
              <div className="text-xs text-slate-400 mt-2">Displaying top 10 matches below...</div>
            </div>
          ) : <div className="p-12 border-2 border-dashed rounded-3xl text-center text-slate-400">Awaiting identification...</div>}
        </section>
      </div>

      <div className="bg-slate-900 p-8 rounded-3xl text-white">
        <button onClick={handleCompile} className="w-full py-4 bg-emerald-600 text-white font-bold rounded-2xl">Generate Master Study Token</button>
        {generatedToken && <div className="mt-4 p-4 bg-black rounded-xl font-mono text-[10px] break-all">{generatedToken}</div>}
      </div>
    </div>
  );
}