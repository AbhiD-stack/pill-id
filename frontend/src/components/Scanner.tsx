// src/components/Scanner.tsx
"use client";

import { useState } from "react";
import { identifyPill, type PillMatch } from "@/lib/api";
import { fullSafetyCheck } from "@/lib/safety";
import { speak, vibrate } from "./AudioAlert";
import { logTelemetry } from "@/lib/telemetry";
import ImageCapture from "./ImageCapture";

export type TimeOfDay = "morning" | "noon" | "night";

export type IdentificationResult = {
  drug_names: string[];
  confidences: number[];
  rotation: number;
  adjustments: number;
  latency_ms: number;
};

export type ScheduledPill = {
  drug_name: string;
  ndc: string | null;
  score: number;
  bucket: TimeOfDay;
};

type Stage = "capture" | "identifying" | "results";

const BUCKETS: { key: TimeOfDay; label: string; time: string; icon: string; classes: string }[] = [
  { key: "morning", label: "Morning", time: "5am – 11am", icon: "🌅", classes: "bg-amber-500 border-amber-300" },
  { key: "noon", label: "Midday", time: "11am – 4pm", icon: "☀️", classes: "bg-cyan-500 border-cyan-300" },
  { key: "night", label: "Evening", time: "6pm – 11pm", icon: "🌙", classes: "bg-indigo-600 border-indigo-300" },
];

interface ScannerProps {
  // Drug names already on the schedule, used for the on-scan interaction
  // check — kept in memory by the parent, no persistence.
  existingDrugNames?: string[];
  onIdentified?: (result: IdentificationResult) => void;
  onScheduled?: (pill: ScheduledPill) => void;
}

export default function Scanner({ existingDrugNames = [], onIdentified, onScheduled }: ScannerProps) {
  const [stage, setStage] = useState<Stage>("capture");
  const [statusMsg, setStatusMsg] = useState("Analyzing pill features...");
  const [error, setError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<{ drug: string; bucket: TimeOfDay } | null>(null);
  const [matches, setMatches] = useState<PillMatch[] | null>(null);
  const [safetyNote, setSafetyNote] = useState<string | null>(null);
  const [scanTime, setScanTime] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const handleImageReady = async (
    canvas: HTMLCanvasElement,
    _width: number,
    _height: number,
    rotation: number,
    adjustments: number
  ) => {
    setStage("identifying");
    setStatusMsg("Analyzing pill features...");
    setError(null);
    setScanTime(null);
    setPreviewUrl(canvas.toDataURL());

    const t0 = performance.now();

    try {
      const results = await identifyPill(canvas, 5);
      const latency = performance.now() - t0;
      setScanTime(Math.round(latency));
      logTelemetry("identify_pill", latency);

      setMatches(results);
      setStage("results");

      onIdentified?.({
        drug_names: results.map((r) => r.drug_name || r.label),
        confidences: results.map((r) => r.score),
        rotation,
        adjustments,
        latency_ms: Math.round(latency),
      });

      const top = results[0];
      if (top) {
        vibrate([100, 50, 100]);

        const { beers, interactions } = await fullSafetyCheck(top.drug_name || top.label, existingDrugNames);
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
      setError(
        err instanceof Error
          ? err.message
          : "Could not reach the identification server. Check your connection and try again."
      );
      setStage("capture");
    }
  };

  const resetScanner = () => {
    setMatches(null);
    setSafetyNote(null);
    setScanTime(null);
    setPreviewUrl(null);
    setError(null);
    setStage("capture");
  };

  function scheduleMatch(match: PillMatch, bucket: TimeOfDay) {
    onScheduled?.({
      drug_name: match.drug_name || match.label,
      ndc: match.ndc,
      score: match.score,
      bucket,
    });
    vibrate(250);
    setJustAdded({ drug: match.drug_name || match.label, bucket });
    setTimeout(() => setJustAdded(null), 2500);
    resetScanner();
  }

  return (
    <div>
      {stage === "capture" && (
        <div className="space-y-3">
          {justAdded && (
            <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800 shadow-sm flex items-center gap-2">
              <span className="text-xl">✅</span>
              <p>
                <strong>{justAdded.drug}</strong> added to your{" "}
                {BUCKETS.find((b) => b.key === justAdded.bucket)?.label} schedule.
              </p>
            </div>
          )}
          {error && (
            <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 text-sm text-red-800 shadow-sm">
              <p className="font-bold">⚠ Scan failed</p>
              <p className="mt-1">{error}</p>
            </div>
          )}
          <ImageCapture onImageReady={handleImageReady} onCancel={() => setStage("capture")} />
        </div>
      )}

      {stage === "identifying" && (
        <div className="text-center py-16">
          <div className="inline-block animate-pulse mb-4 text-5xl">🔍</div>
          <p className="text-xl font-bold text-slate-900">{statusMsg}</p>
          <p className="text-sm text-slate-500 mt-2">Contacting the identification server...</p>
        </div>
      )}

      {stage === "results" && matches && (
        <ResultsView
          matches={matches}
          safetyNote={safetyNote}
          scanTime={scanTime}
          previewUrl={previewUrl}
          onSchedule={scheduleMatch}
          onRetake={resetScanner}
        />
      )}
    </div>
  );
}

function ResultsView({
  matches,
  safetyNote,
  scanTime,
  previewUrl,
  onSchedule,
  onRetake,
}: {
  matches: PillMatch[];
  safetyNote: string | null;
  scanTime: number | null;
  previewUrl: string | null;
  onSchedule: (match: PillMatch, bucket: TimeOfDay) => void;
  onRetake: () => void;
}) {
  const [selectedLabel, setSelectedLabel] = useState(matches[0].label);
  const [dragOverBucket, setDragOverBucket] = useState<TimeOfDay | null>(null);
  const selected = matches.find((m) => m.label === selectedLabel) || matches[0];

  function handleDragStart(e: React.DragEvent, match: PillMatch) {
    setSelectedLabel(match.label);
    e.dataTransfer.setData("text/plain", match.label);
  }

  function handleDrop(e: React.DragEvent, bucket: TimeOfDay) {
    e.preventDefault();
    setDragOverBucket(null);
    const label = e.dataTransfer.getData("text/plain");
    const matchToUse = matches.find((m) => m.label === label) || selected;
    onSchedule(matchToUse, bucket);
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-12">
      {scanTime && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center shadow-sm">
          <p className="text-xs text-slate-600 font-medium">
            ⚡ Identified in <strong className="text-slate-900">{scanTime}ms</strong>
          </p>
        </div>
      )}

      {/* Side-by-Side Comparison */}
      <div className="bg-white border-2 border-slate-200 rounded-3xl p-5 shadow-md">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wider">
            Comparison View
          </h3>
          <button
            onClick={() => speak(`${selected.drug_name || selected.label}. Confidence: ${(selected.score * 100).toFixed(0)} percent.`)}
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
            <p className="text-xs font-bold text-indigo-700 mb-2">
              {selected === matches[0] ? "Top Match Reference" : "Selected Match Reference"}
            </p>
            {selected.reference_image_url ? (
              <img
                src={selected.reference_image_url}
                alt={selected.drug_name || selected.label}
                className="w-32 h-32 object-contain mx-auto rounded-lg border border-indigo-200 bg-white shadow-inner p-1"
              />
            ) : (
              <div className="w-32 h-32 bg-indigo-100 rounded-lg mx-auto flex items-center justify-center text-indigo-300">No Image</div>
            )}
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-slate-400">Tap any match below to compare it here.</p>
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

      {/* Time buckets — tap to add the selected match; drag also works */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-bold text-slate-700 uppercase tracking-wider">
            Add to Schedule
          </label>
          <span className="text-xs text-slate-400">
            Adding: <strong className="text-slate-600">{selected.drug_name || selected.label}</strong>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {BUCKETS.map((bucket) => (
            <button
              key={bucket.key}
              type="button"
              onClick={() => onSchedule(selected, bucket.key)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverBucket(bucket.key);
              }}
              onDragLeave={() => setDragOverBucket((b) => (b === bucket.key ? null : b))}
              onDrop={(e) => handleDrop(e, bucket.key)}
              className={`group min-h-tap px-4 py-5 flex flex-col items-center justify-center gap-1 rounded-3xl border-4 border-dashed text-white shadow-md transition-all duration-150 ${bucket.classes} ${
                dragOverBucket === bucket.key ? "scale-[1.06] shadow-2xl ring-4 ring-white/70" : "hover:scale-105 hover:shadow-lg"
              }`}
            >
              <span className="text-3xl">{bucket.icon}</span>
              <span className="text-lg font-black tracking-wide">{bucket.label}</span>
              <span className="text-xs text-white/90 font-medium">{bucket.time}</span>
              <span className="mt-1 text-[11px] font-bold uppercase tracking-wider bg-white/20 px-3 py-1 rounded-full backdrop-blur-sm">
                Tap to Add
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Top Matches — tap to compare, drag to schedule directly */}
      <div className="space-y-3 pt-2">
        <p className="text-sm font-bold text-slate-700 uppercase tracking-wider">
          Top Matches <span className="text-xs font-normal text-slate-400 lowercase">(tap to compare · drag onto a time above)</span>
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {matches.map((m, idx) => {
            const isSelected = m.label === selectedLabel;
            return (
              <div
                key={m.label}
                role="button"
                tabIndex={0}
                draggable
                onClick={() => setSelectedLabel(m.label)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setSelectedLabel(m.label);
                }}
                onDragStart={(e) => handleDragStart(e, m)}
                className={`group flex flex-col justify-between rounded-2xl border-2 bg-white p-4 shadow-sm transition-all cursor-pointer select-none relative ${
                  isSelected ? "border-indigo-500 ring-2 ring-indigo-200 shadow-md" : "border-slate-200 hover:border-indigo-300 hover:shadow-md"
                }`}
                title="Tap to compare, or drag onto a time bucket"
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
                  <div
                    className={`flex-1 text-center py-1.5 rounded-xl font-bold text-xs transition ${
                      isSelected ? "bg-indigo-600 text-white" : "bg-indigo-50 text-indigo-700 group-hover:bg-indigo-100"
                    }`}
                  >
                    {isSelected ? "✓ Comparing" : "Tap to Compare"}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      speak(`${m.drug_name || m.label}, confidence ${(m.score * 100).toFixed(0)} percent`);
                    }}
                    className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition"
                    title="Read Aloud"
                  >
                    🔊
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <button
        onClick={onRetake}
        className="w-full min-h-tap px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-2xl transition shadow-sm text-base"
      >
        Scan Another Pill
      </button>
    </div>
  );
}
