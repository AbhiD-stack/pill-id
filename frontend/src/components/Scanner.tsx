// src/components/Scanner.tsx
"use client";

import { useState } from "react";
import { identifyPill, type PillMatch } from "@/lib/api";
import { addLogEntry, addScheduleEntry, checkCompliance, getRecentDrugNames, TimeOfDay } from "@/lib/db";
import { fullSafetyCheck } from "@/lib/safety";
import { speak, vibrate } from "./AudioAlert";
import { logTelemetry } from "@/lib/telemetry";
import ImageCapture from "./ImageCapture";

type Stage = "capture-front" | "capture-back" | "identifying" | "results";

export default function Scanner() {
  const [stage, setStage] = useState<Stage>("capture-front");
  const [statusMsg, setStatusMsg] = useState("Analyzing pill features...");
  const [matches, setMatches] = useState<PillMatch[] | null>(null);
  const [lowConfidence, setLowConfidence] = useState(false);
  const [ocrImprintRead, setOcrImprintRead] = useState<string | null>(null);
  const [safetyNote, setSafetyNote] = useState<string | null>(null);
  const [scanTime, setScanTime] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [frontCanvas, setFrontCanvas] = useState<HTMLCanvasElement | null>(null);

  const handleFrontCaptured = (canvas: HTMLCanvasElement) => {
    setFrontCanvas(canvas);
    setPreviewUrl(canvas.toDataURL());
    setStage("capture-back");
  };

  const runIdentify = async (front: HTMLCanvasElement, back: HTMLCanvasElement | null) => {
    setStage("identifying");
    setStatusMsg("Analyzing pill features...");
    setScanTime(null);

    const t0 = performance.now();

    try {
      const result = await identifyPill(front, 5, back);
      const latency = performance.now() - t0;
      setScanTime(Math.round(latency));
      logTelemetry("identify_pill", latency);

      setMatches(result.matches);
      setLowConfidence(result.lowConfidence);
      setOcrImprintRead(result.ocrImprintRead);
      setStage("results");

      const top = result.matches[0];
      if (top) {
        vibrate([100, 50, 100]);

        const existing = await getRecentDrugNames(24 * 30);
        const { beers, interactions } = await fullSafetyCheck(top.drug_name || top.label, existing);
        if (beers) {
          setSafetyNote(`⚠ Beers Criteria flag (${beers.risk_level}): ${beers.rationale} ${beers.recommendation}`);
        } else if (interactions.length > 0) {
          const i = interactions[0];
          setSafetyNote(`⚠ Interaction flag (${i.severity}): ${i.description}`);
        } else {
          setSafetyNote(null);
        }
      }
    } catch (err) {
      console.error("Scan failed:", err);
      setStatusMsg("Scan failed. Try again.");
      setStage("capture-front");
    }
  };

  const resetScanner = () => {
    setMatches(null);
    setLowConfidence(false);
    setOcrImprintRead(null);
    setSafetyNote(null);
    setScanTime(null);
    setPreviewUrl(null);
    setFrontCanvas(null);
    setStage("capture-front");
  };

  async function scheduleDrop(match: PillMatch, bucket: TimeOfDay) {
    await addScheduleEntry({
      drugName: match.drug_name || match.label,
      ndc: match.ndc ?? undefined,
      bucket,
    });
    const now = new Date();
    const onSchedule = checkCompliance(now, bucket);
    await addLogEntry({
      drugName: match.drug_name || match.label,
      ndc: match.ndc ?? undefined,
      scannedAt: now.getTime(),
      bucket,
      onSchedule,
    });
    vibrate(250);
    resetScanner();
  }

  return (
    <div>
      {stage === "capture-front" && (
        <ImageCapture
          sideLabel="front"
          onImageReady={(canvas) => handleFrontCaptured(canvas)}
          onCancel={() => setStage("capture-front")}
        />
      )}

      {stage === "capture-back" && frontCanvas && (
        <ImageCapture
          sideLabel="back"
          allowSkip
          onSkip={() => runIdentify(frontCanvas, null)}
          onImageReady={(canvas) => runIdentify(frontCanvas, canvas)}
          onCancel={() => setStage("capture-front")}
        />
      )}

      {stage === "identifying" && (
        <div className="text-center py-12">
          <div className="inline-block animate-pulse mb-4 text-4xl">🔍</div>
          <p className="text-lg font-medium text-slate-900">{statusMsg}</p>
          <p className="text-sm text-slate-500 mt-2">Contacting the identification server...</p>
        </div>
      )}

      {stage === "results" && matches && (
        <ResultsView
          matches={matches}
          lowConfidence={lowConfidence}
          ocrImprintRead={ocrImprintRead}
          safetyNote={safetyNote}
          scanTime={scanTime}
          previewUrl={previewUrl}
          onDrop={scheduleDrop}
          onRetake={resetScanner}
        />
      )}
    </div>
  );
}

function ResultsView({
  matches,
  lowConfidence,
  ocrImprintRead,
  safetyNote,
  scanTime,
  previewUrl,
  onDrop,
  onRetake,
}: {
  matches: PillMatch[];
  lowConfidence: boolean;
  ocrImprintRead: string | null;
  safetyNote: string | null;
  scanTime: number | null;
  previewUrl: string | null;
  onDrop: (match: PillMatch, bucket: TimeOfDay) => void;
  onRetake: () => void;
}) {
  function handleDragStart(e: React.DragEvent, match: PillMatch) {
    e.dataTransfer.setData("text/plain", match.label);
  }

  function handleDrop(e: React.DragEvent, bucket: TimeOfDay) {
    e.preventDefault();
    const label = e.dataTransfer.getData("text/plain");
    const matchToUse = matches.find((m) => m.label === label) || matches[0];
    onDrop(matchToUse, bucket);
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-12">
      {lowConfidence && (
        <div className="bg-red-50 border-l-4 border-red-500 rounded-r-xl p-4 shadow-sm">
          <p className="text-sm text-red-900 font-semibold">
            ⚠ Low confidence match — none of these candidates strongly match the photo.
          </p>
          <p className="text-xs text-red-800 mt-1">
            Do not act on this result. Retake with better lighting/focus, or confirm with a
            pharmacist and the physical packaging.
          </p>
        </div>
      )}
      {ocrImprintRead && (
        <p className="text-xs text-slate-400 text-center">
          Imprint text read from photo: <span className="font-mono">{ocrImprintRead}</span>
        </p>
      )}
      {scanTime && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center shadow-sm">
          <p className="text-xs text-slate-600 font-medium">
            ⚡ Identified in <strong className="text-slate-900">{scanTime}ms</strong>
          </p>
        </div>
      )}

      {/* Side-by-Side Comparison */}
      <div className="bg-white border-2 border-slate-200 rounded-2xl p-5 shadow-md">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wider">
            Comparison View
          </h3>
          <button
            onClick={() => speak(`Top match: ${matches[0].drug_name || matches[0].label}. Confidence: ${(matches[0].score * 100).toFixed(0)} percent.`)}
            className="text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold px-3 py-1 rounded-lg transition flex items-center gap-1"
          >
            🔊 Read Aloud
          </button>
        </div>
        <div className="grid grid-cols-2 gap-4 items-center">
          <div className="text-center bg-slate-50 p-3 rounded-xl border border-slate-200">
            <p className="text-xs font-bold text-slate-500 mb-2">Your Photo Scan</p>
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="Your scan"
                className="w-32 h-32 object-contain mx-auto rounded-lg border border-slate-300 bg-white shadow-inner"
              />
            ) : (
              <div className="w-32 h-32 bg-slate-200 rounded-lg mx-auto flex items-center justify-center text-slate-400">No Image</div>
            )}
          </div>
          <div className="text-center bg-indigo-50/55 p-3 rounded-xl border border-indigo-200">
            <p className="text-xs font-bold text-indigo-700 mb-2">Top Match Reference</p>
            {matches[0].reference_image_url ? (
              <img
                src={matches[0].reference_image_url}
                alt={matches[0].drug_name || matches[0].label}
                className="w-32 h-32 object-contain mx-auto rounded-lg border border-indigo-200 bg-white shadow-inner p-1"
              />
            ) : (
              <div className="w-32 h-32 bg-indigo-100 rounded-lg mx-auto flex items-center justify-center text-indigo-300">No Image</div>
            )}
          </div>
        </div>
      </div>

      {safetyNote && (
        <div className="bg-red-50 border-l-4 border-red-500 rounded-r-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-sm text-red-900 font-medium">{safetyNote}</p>
            <button
              onClick={() => speak(safetyNote)}
              className="text-xs bg-red-100 hover:bg-red-200 text-red-800 font-bold px-2 py-1 rounded transition shrink-0 ml-2"
            >
              🔊 Read
            </button>
          </div>
        </div>
      )}

      {/* Time Slots Drop Zones */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-bold text-slate-700 uppercase tracking-wider">
            Drag Any Match Box to Schedule
          </label>
          <span className="text-xs text-slate-400">Drop into a time box below</span>
        </div>

        <div className="grid grid-cols-1 gap-3">
          {(["morning", "noon", "night"] as TimeOfDay[]).map((bucket) => (
            <div
              key={bucket}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleDrop(e, bucket)}
              className={`group relative overflow-hidden min-h-[80px] px-6 flex items-center justify-between rounded-2xl border-4 border-dashed transition-all shadow-md ${
                bucket === "morning"
                  ? "bg-amber-500 border-amber-300 text-white"
                  : bucket === "noon"
                    ? "bg-cyan-500 border-cyan-300 text-white"
                    : "bg-indigo-600 border-indigo-300 text-white"
              }`}
            >
              <div className="flex items-center gap-4">
                <span className="text-3xl">
                  {bucket === "morning" && "🌅"}
                  {bucket === "noon" && "☀️"}
                  {bucket === "night" && "🌙"}
                </span>
                <div>
                  <p className="text-xl font-black capitalize tracking-wide">{bucket}</p>
                  <p className="text-xs text-white/90 font-medium">Drop pill box here</p>
                </div>
              </div>
              <div className="bg-white/20 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider backdrop-blur-sm">
                Target Box 📥
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Square Match Cards Grid */}
      <div className="space-y-3 pt-2">
        <p className="text-sm font-bold text-slate-700 uppercase tracking-wider">
          Top Matches <span className="text-xs font-normal text-slate-400 lowercase">(drag any square box to schedule)</span>
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {matches.map((m, idx) => (
            <div
              key={m.label}
              draggable
              onDragStart={(e) => handleDragStart(e, m)}
              className="group flex flex-col justify-between rounded-2xl border-2 border-slate-200 hover:border-indigo-500 bg-white p-4 shadow-sm hover:shadow-md cursor-grab active:cursor-grabbing transition-all select-none relative"
              title="Click and drag this box into a time bucket"
            >
              {idx === 0 && (
                <span className="absolute top-2 right-2 bg-indigo-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                  Top Match
                </span>
              )}
              <div className="flex items-center gap-3">
                <img
                  src={m.reference_image_url || ""}
                  alt={m.drug_name || m.label}
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 24 24' fill='none' stroke='%23cbd5e1' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='18' x='3' y='3' rx='2' ry='2'/%3E%3Ccircle cx='9' cy='9' r='2'/%3E%3Cpath d='m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'/%3E%3C/svg%3E";
                  }}
                  className="w-16 h-16 rounded-xl border border-slate-200 object-contain bg-slate-50 p-1 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-slate-900 text-sm truncate">{m.drug_name || m.label}</p>
                  <p className="text-[11px] text-slate-400 font-mono">NDC: {m.ndc || "N/A"}</p>
                  <p className="text-xs font-bold text-emerald-600 mt-0.5">{(m.score * 100).toFixed(0)}% confidence</p>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="flex-1 text-center bg-indigo-50 group-hover:bg-indigo-600 group-hover:text-white text-indigo-700 py-1.5 rounded-xl font-bold text-xs transition">
                  💊 Drag Box
                </div>
                <button
                  onClick={() => speak(`${m.drug_name || m.label}, confidence ${(m.score * 100).toFixed(0)} percent`)}
                  className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition"
                  title="Read Aloud"
                >
                  🔊
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={onRetake}
        className="w-full px-4 py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-2xl transition shadow-sm text-base"
      >
        Scan Another Pill
      </button>
    </div>
  );
}
