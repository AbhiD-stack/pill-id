"use client";

import { useCallback, useState, useRef } from "react";
import ReactCrop, { type Crop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { predictPill, referenceImageSrc, type PredictionResult } from "@/lib/api";

interface TelemetryRun {
  pill_name: string;
  ndc: string;
  confidence: number;
  rotations: number;
  adjustments: number;
  latency_sec: number;
}

export function PillIdentifier() {
  const [imgSrc, setImgSrc] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<Crop | null>(null);
  const [rotation, setRotation] = useState(0);

  const [rotationCount, setRotationCount] = useState(0);
  const [cropAdjustmentCount, setCropAdjustmentCount] = useState(0);
  const [timeToInference, setTimeToInference] = useState(0);
  const timerRef = useRef<number | null>(null);
  
  const [studyBatchLogs, setStudyBatchLogs] = useState<TelemetryRun[]>([]);
  const [rawResults, setRawResults] = useState<PredictionResult[] | null>(null);
  const [showAllResults, setShowAllResults] = useState(false);
  const [loading, setLoading] = useState(false);

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    const initialCrop = centerCrop(makeAspectCrop({ unit: "%", width: 80, aspect: 1 }, width, height), width, height);
    setCrop(initialCrop); setCompletedCrop(initialCrop);
    const start = Date.now();
    timerRef.current = window.setInterval(() => setTimeToInference(Math.round((Date.now() - start) / 1000)), 1000);
  }

  const onIdentify = useCallback(async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setLoading(true);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const scaleX = imgRef.current!.naturalWidth / imgRef.current!.width;
    const scaleY = imgRef.current!.naturalHeight / imgRef.current!.height;
    canvas.width = 512; canvas.height = 512;
    ctx?.translate(256, 256); ctx?.rotate((rotation * Math.PI) / 180);
    ctx?.drawImage(imgRef.current!, completedCrop!.x * scaleX, completedCrop!.y * scaleY, completedCrop!.width * scaleX, completedCrop!.height * scaleY, -256, -256, 512, 512);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.95));
    
    const res = await predictPill(new File([blob!], "p.jpg", { type: "image/jpeg" }));
    setRawResults(res.predictions);
    setStudyBatchLogs(prev => [...prev, {
      pill_name: res.predictions[0].name, ndc: res.predictions[0].ndc,
      confidence: res.predictions[0].score_pct, rotations: rotationCount,
      adjustments: cropAdjustmentCount, latency_sec: timeToInference
    }]);
    setLoading(false);
  }, [completedCrop, rotation, rotationCount, cropAdjustmentCount, timeToInference]);

  const handleCompile = () => {
    const token = `[PILOT_PASSIVE|Count:${studyBatchLogs.length}] { ${studyBatchLogs.map(r => 
      `${r.pill_name}|Conf:${r.confidence}%|Rot:${r.rotations}|Adj:${r.adjustments}|Lat:${r.latency_sec}s`
    ).join(" || ")} }`;
    navigator.clipboard.writeText(token);
    alert("Copied master study token to clipboard!");
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div className="grid lg:grid-cols-2 gap-8">
        <section className="bg-white p-6 rounded-3xl border shadow-sm">
          <h2 className="text-sm font-bold text-slate-500 uppercase mb-4">Step 1: Frame Pill</h2>
          {!imgSrc ? (
            <label className="flex aspect-square border-4 border-dashed rounded-3xl items-center justify-center cursor-pointer border-slate-300">
              <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                const reader = new FileReader();
                reader.onload = (ev) => setImgSrc(ev.target?.result as string);
                reader.readAsDataURL(e.target.files![0]);
              }} />
              <p className="font-bold text-slate-500">Tap to Select Image</p>
            </label>
          ) : (
            <div className="border-4 border-slate-900 rounded-3xl p-4 bg-slate-950">
              <ReactCrop crop={crop} onChange={c => setCrop(c)} onComplete={c => setCompletedCrop(c)} aspect={1}>
                <img ref={imgRef} src={imgSrc} onLoad={onImageLoad} style={{ transform: `rotate(${rotation}deg)` }} className="max-h-96" />
              </ReactCrop>
              <button onClick={() => {setRotation(r => (r + 90) % 360); setRotationCount(c => c + 1);}} className="w-full mt-4 py-2 bg-slate-800 text-white rounded-xl font-bold text-xs">Rotate 90°</button>
            </div>
          )}
          <button onClick={onIdentify} disabled={!imgSrc || loading} className="w-full mt-4 py-4 bg-sky-600 text-white font-bold rounded-2xl">
            {loading ? "Analyzing..." : "Identify Pill"}
          </button>
        </section>

        <section>
          <h2 className="text-sm font-bold text-slate-500 uppercase mb-4">Step 2: Analysis Results</h2>
          {rawResults ? (
            <div className="space-y-2">
              {(showAllResults ? rawResults : rawResults.slice(0, 5)).map((r, i) => (
                <div key={i} className="p-3 bg-slate-100 rounded-xl font-mono text-sm">{r.name} ({r.score_pct}%)</div>
              ))}
              <button onClick={() => setShowAllResults(!showAllResults)} className="text-xs text-sky-600 font-bold underline">
                {showAllResults ? "Show Less" : "Show 6-10"}
              </button>
            </div>
          ) : <div className="p-12 border-2 border-dashed rounded-3xl text-center text-slate-400">Waiting for identification...</div>}
        </section>
      </div>
      <button onClick={handleCompile} className="w-full py-6 bg-emerald-700 text-white font-bold rounded-3xl">Generate & Copy Master Token</button>
    </div>
  );
}