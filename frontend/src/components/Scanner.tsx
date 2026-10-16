// src/components/Scanner.tsx
"use client";

import { useState } from "react";
import { identifyPill, readImprint, submitFeedback, type PillMatch, type SearchResult } from "@/lib/api";
import { addLogEntry, addScheduleEntry, addReferencePill, checkCompliance, getRecentDrugNames, getReferencePills, TimeOfDay } from "@/lib/db";
import { scoreMyPills, judgeMyPillMatch, type MyPillVerdict } from "@/lib/myPills";
import { fullSafetyCheck } from "@/lib/safety";
import { speak, vibrate } from "./AudioAlert";
import { logTelemetry } from "@/lib/telemetry";
import ImageCapture from "./ImageCapture";
import PillSearchPanel from "./PillSearchPanel";
import PillThumb from "./PillThumb";

type Stage = "capture-front" | "capture-back" | "imprint" | "identifying" | "results";
type ImprintSource = "user" | "ocr" | null;

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
  const [backCanvas, setBackCanvas] = useState<HTMLCanvasElement | null>(null);
  const [imprintSide1, setImprintSide1] = useState("");
  const [imprintSide2, setImprintSide2] = useState("");
  const [imprintReading, setImprintReading] = useState(false);
  const [imprintSource, setImprintSource] = useState<ImprintSource>(null);
  const [predictionId, setPredictionId] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [queryEmbeddings, setQueryEmbeddings] = useState<number[][] | null>(null);
  const [myPillVerdict, setMyPillVerdict] = useState<MyPillVerdict>(null);

  const handleFrontCaptured = (canvas: HTMLCanvasElement) => {
    setFrontCanvas(canvas);
    setPreviewUrl(canvas.toDataURL());
    setStage("capture-back");
  };

  // After the photos: suggest the imprint read from them, for the user to
  // confirm or correct. Fields the user already typed into are left alone.
  const handleBackDone = async (front: HTMLCanvasElement, back: HTMLCanvasElement | null) => {
    setBackCanvas(back);
    setImprintSide1("");
    setImprintSide2("");
    setStage("imprint");
    setImprintReading(true);
    try {
      const read = await readImprint(front, back);
      setImprintSide1((prev) => prev || read.side_1);
      setImprintSide2((prev) => prev || read.side_2);
    } catch (err) {
      console.error("Imprint read failed (non-fatal):", err);
    } finally {
      setImprintReading(false);
    }
  };

  const runIdentify = async (front: HTMLCanvasElement, back: HTMLCanvasElement | null, imprint: string) => {
    setStage("identifying");
    setStatusMsg("Analyzing pill features...");
    setScanTime(null);

    const t0 = performance.now();

    setScanError(null);
    let result;
    try {
      result = await identifyPill(front, 5, back, imprint);
    } catch (err: any) {
      console.error("Scan failed:", err);
      setScanError(err?.message || String(err));
      setStage("capture-front");
      return;
    }

    const latency = performance.now() - t0;
    setScanTime(Math.round(latency));
    logTelemetry("identify_pill", latency);

    setMatches(result.matches);
    setLowConfidence(result.lowConfidence);
    setOcrImprintRead(result.ocrImprintRead);
    setPredictionId(result.predictionId);
    setImprintSource(result.imprintSource);
    setQueryEmbeddings(result.queryEmbeddings);
    setMyPillVerdict(null);
    setStage("results");

    // My Pills: compare against the user's own saved photos, on-device.
    if (result.queryEmbeddings) {
      try {
        const saved = await getReferencePills();
        const galleryTop = Math.max(-1, ...result.matches.map((m) => m.score));
        setMyPillVerdict(judgeMyPillMatch(scoreMyPills(result.queryEmbeddings, saved), galleryTop));
      } catch (err) {
        console.error("My Pills comparison failed (non-fatal):", err);
      }
    }

    // Safety check is best-effort and must never roll back a successful
    // identification just because it itself failed (e.g. the static
    // beers_criteria.json/drug_interactions.json fetch hiccuped) -- that
    // used to share a try/catch with the identify call above, so any
    // failure here silently reset the whole screen back to the capture
    // step even though the match had already come back fine.
    const top = result.matches[0];
    if (top) {
      vibrate([100, 50, 100]);
      try {
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
      } catch (err) {
        console.error("Safety check failed (non-fatal):", err);
        setSafetyNote(null);
      }
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
    setBackCanvas(null);
    setImprintSide1("");
    setImprintSide2("");
    setImprintSource(null);
    setPredictionId(null);
    setScanError(null);
    setQueryEmbeddings(null);
    setMyPillVerdict(null);
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

  async function saveToMyPills(info: {
    drugName: string;
    ndc: string | null;
    imprint: string | null;
    color: string | null;
    shape: string | null;
  }) {
    if (!previewUrl) return;
    await addReferencePill({
      drugName: info.drugName,
      ndc: info.ndc ?? undefined,
      imprint: info.imprint ?? undefined,
      color: info.color ?? undefined,
      shape: info.shape ?? undefined,
      photoDataUrl: previewUrl,
      embeddings: queryEmbeddings ?? undefined,
    });
    vibrate(150);
  }

  const saveAsReference = (match: PillMatch) =>
    saveToMyPills({ ...match, drugName: match.drug_name || match.label });

  const saveFromSearch = (r: SearchResult) =>
    saveToMyPills({ ...r, drugName: r.name || r.label });

  return (
    <div>
      {stage === "capture-front" && (
        <>
          {scanError && (
            <div className="bg-red-50 border-l-4 border-red-500 rounded-r-xl p-4 shadow-sm mb-4">
              <p className="text-sm text-red-900 font-semibold">⚠ Scan failed</p>
              <p className="text-xs text-red-800 mt-1 break-words">{scanError}</p>
            </div>
          )}
          <ImageCapture
            sideLabel="front"
            onImageReady={(canvas) => handleFrontCaptured(canvas)}
            onCancel={() => setStage("capture-front")}
          />
        </>
      )}

      {stage === "capture-back" && frontCanvas && (
        <ImageCapture
          sideLabel="back"
          allowSkip
          onSkip={() => handleBackDone(frontCanvas, null)}
          onImageReady={(canvas) => handleBackDone(frontCanvas, canvas)}
          onCancel={() => setStage("capture-front")}
        />
      )}

      {stage === "imprint" && frontCanvas && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runIdentify(frontCanvas, backCanvas, [imprintSide1, imprintSide2].join(" ").trim());
          }}
          className="max-w-md mx-auto space-y-4 py-4"
        >
          <div className="text-center">
            <p className="text-lg font-bold text-slate-900">What letters or numbers are on the pill?</p>
            <p className="text-sm text-slate-500 mt-1">
              This is the most reliable way to identify a pill. Check both sides and correct anything that&apos;s wrong.
            </p>
          </div>
          {imprintReading && (
            <p className="text-xs text-indigo-600 text-center animate-pulse">Reading the pill from your photo…</p>
          )}
          {!imprintReading && (imprintSide1 || imprintSide2) && (
            <p className="text-xs text-amber-700 text-center">
              Filled in from your photo. Please check it against the pill.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-slate-600">
              Side 1
              <input
                type="text"
                value={imprintSide1}
                onChange={(e) => setImprintSide1(e.target.value)}
                placeholder="e.g. L"
                className="mt-1 w-full px-3 py-3 border border-slate-300 rounded-xl text-lg font-mono uppercase"
                autoCapitalize="characters"
              />
            </label>
            <label className="text-xs font-semibold text-slate-600">
              Side 2
              <input
                type="text"
                value={imprintSide2}
                onChange={(e) => setImprintSide2(e.target.value)}
                placeholder="e.g. 5"
                className="mt-1 w-full px-3 py-3 border border-slate-300 rounded-xl text-lg font-mono uppercase"
                autoCapitalize="characters"
              />
            </label>
          </div>
          <button
            type="submit"
            className="w-full px-4 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl transition shadow-sm text-base"
          >
            Find my pill
          </button>
          <button
            type="button"
            onClick={() => runIdentify(frontCanvas, backCanvas, "")}
            className="w-full text-sm text-slate-500 hover:text-slate-700 underline"
          >
            There are no letters or numbers
          </button>
        </form>
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
          predictionId={predictionId}
          imprintSource={imprintSource}
          myPillVerdict={myPillVerdict}
          onChangeImprint={() => setStage("imprint")}
          onDrop={scheduleDrop}
          onSaveReference={saveAsReference}
          onSaveFromSearch={saveFromSearch}
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
  predictionId,
  imprintSource,
  myPillVerdict,
  onChangeImprint,
  onDrop,
  onSaveReference,
  onSaveFromSearch,
  onRetake,
}: {
  matches: PillMatch[];
  lowConfidence: boolean;
  ocrImprintRead: string | null;
  safetyNote: string | null;
  scanTime: number | null;
  previewUrl: string | null;
  predictionId: string | null;
  imprintSource: ImprintSource;
  myPillVerdict: MyPillVerdict;
  onChangeImprint: () => void;
  onDrop: (match: PillMatch, bucket: TimeOfDay) => void;
  onSaveReference: (match: PillMatch) => Promise<void>;
  onSaveFromSearch: (result: SearchResult) => Promise<void>;
  onRetake: () => void;
}) {
  const [feedbackState, setFeedbackState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [savedLabels, setSavedLabels] = useState<Set<string>>(new Set());
  const [showAppearanceSearch, setShowAppearanceSearch] = useState(false);
  const [showSaveSearch, setShowSaveSearch] = useState(false);
  const [savedFromSearch, setSavedFromSearch] = useState<string | null>(null);

  function handleDragStart(e: React.DragEvent, match: PillMatch) {
    e.dataTransfer.setData("text/plain", match.label);
  }

  function handleDrop(e: React.DragEvent, bucket: TimeOfDay) {
    e.preventDefault();
    const label = e.dataTransfer.getData("text/plain");
    const matchToUse = matches.find((m) => m.label === label) || matches[0];
    onDrop(matchToUse, bucket);
  }

  async function sendFeedback(correct: boolean, reportedLabel?: string | null) {
    if (!predictionId || feedbackState === "sending" || feedbackState === "sent") return;
    setFeedbackState("sending");
    try {
      await submitFeedback(predictionId, correct, reportedLabel);
      setFeedbackState("sent");
    } catch (err) {
      // Best-effort: feedback failing should never disrupt the scan result
      // the user is already looking at.
      console.error("Feedback submission failed:", err);
      setFeedbackState("error");
    }
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-12">
      {myPillVerdict && (
        <div
          className={`rounded-2xl p-4 shadow-sm border-2 ${
            myPillVerdict.kind === "strong" ? "bg-emerald-50 border-emerald-400" : "bg-amber-50 border-amber-300"
          }`}
        >
          <p
            className={`text-xs font-bold uppercase tracking-wider ${
              myPillVerdict.kind === "strong" ? "text-emerald-700" : "text-amber-700"
            }`}
          >
            {myPillVerdict.kind === "strong" ? "✓ Matches a pill in My Pills" : "Could be a pill in My Pills"}
          </p>
          <div className="flex items-center gap-3 mt-2">
            <img
              src={myPillVerdict.match.pill.photoDataUrl}
              alt={myPillVerdict.match.pill.drugName}
              className="w-16 h-16 rounded-xl border border-slate-200 object-contain bg-white p-1 shrink-0"
            />
            <div className="min-w-0">
              <p className="font-bold text-slate-900 truncate">{myPillVerdict.match.pill.drugName}</p>
              <p className="text-xs text-slate-600">
                {(myPillVerdict.match.score * 100).toFixed(0)}% match to the photo you saved on{" "}
                {new Date(myPillVerdict.match.pill.savedAt).toLocaleDateString()}
              </p>
            </div>
          </div>
          {myPillVerdict.runnerUp && (
            <p className="text-xs text-amber-800 mt-2">
              Also very close: <strong>{myPillVerdict.runnerUp.pill.drugName}</strong>. These two look alike, so
              compare the photos carefully.
            </p>
          )}
          {myPillVerdict.kind === "possible" && (
            <p className="text-xs text-amber-800 mt-2">
              Not a confident match. Compare it with your saved photo before relying on it.
            </p>
          )}
        </div>
      )}
      {lowConfidence && (
        <div className="bg-red-50 border-l-4 border-red-500 rounded-r-xl p-4 shadow-sm">
          <p className="text-sm text-red-900 font-semibold">
            ⚠ Weak visual match — none of these candidates closely match the photo.
          </p>
          <p className="text-xs text-red-800 mt-1">
            Do not act on this result. Retake with better lighting/focus, or confirm with a
            pharmacist and the physical packaging.
          </p>
        </div>
      )}
      <div className="flex items-center justify-center gap-2 text-xs text-slate-500">
        {imprintSource === "user" && ocrImprintRead ? (
          <span>
            Matched using imprint <span className="font-mono font-bold text-slate-800">{ocrImprintRead}</span>
          </span>
        ) : ocrImprintRead ? (
          <span>
            Imprint guessed from photo (not checked): <span className="font-mono">{ocrImprintRead}</span>
          </span>
        ) : (
          <span>No imprint used — matched on appearance only</span>
        )}
        <button onClick={onChangeImprint} className="text-indigo-600 font-semibold underline">
          {ocrImprintRead ? "Change" : "Add imprint"}
        </button>
      </div>
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
            <div className="flex justify-center">
              <PillThumb
                url={matches[0].reference_image_url}
                kind={matches[0].reference_image_kind}
                alt={matches[0].drug_name || matches[0].label}
                className="w-32 h-32"
              />
            </div>
            {(matches[0].imprint || matches[0].color || matches[0].shape) && (
              <p className="text-[11px] text-indigo-900 mt-2 leading-snug break-words">
                {[matches[0].imprint && `Imprint ${matches[0].imprint}`, matches[0].color, matches[0].shape]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
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
              className="group flex flex-col justify-between min-w-0 rounded-2xl border-2 border-slate-200 hover:border-indigo-500 bg-white p-4 shadow-sm hover:shadow-md cursor-grab active:cursor-grabbing transition-all select-none relative"
              title="Click and drag this box into a time bucket"
            >
              {idx === 0 && (
                <span className="absolute top-2 right-2 bg-indigo-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                  Top Match
                </span>
              )}
              <div className="flex items-center gap-3">
                <PillThumb
                  url={m.reference_image_url}
                  kind={m.reference_image_kind}
                  alt={m.drug_name || m.label}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-slate-900 text-sm truncate">{m.drug_name || m.label}</p>
                  <p className="text-[11px] text-slate-400 font-mono truncate">NDC: {m.ndc || "N/A"}</p>
                  {(m.imprint || m.color || m.shape) && (
                    <p className="text-[11px] text-slate-500 truncate">
                      {[m.imprint && `Imprint: ${m.imprint}`, m.color, m.shape].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {imprintSource === "user" && m.imprint_match_score >= 0.99 && (
                    <p className="text-[11px] font-bold text-emerald-700">✓ Imprint matches what you entered</p>
                  )}
                  <p className="text-xs font-bold text-emerald-600 mt-0.5">{(m.score * 100).toFixed(0)}% visual match</p>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="flex-1 text-center bg-indigo-50 group-hover:bg-indigo-600 group-hover:text-white text-indigo-700 py-1.5 rounded-xl font-bold text-xs transition">
                  💊 Drag Box
                </div>
                <button
                  onClick={() => speak(`${m.drug_name || m.label}, visual match ${(m.score * 100).toFixed(0)} percent`)}
                  className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition"
                  title="Read Aloud"
                >
                  🔊
                </button>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    setSavedLabels((prev) => new Set(prev).add(m.label));
                    try {
                      await onSaveReference(m);
                    } catch (err) {
                      console.error("Saving to My Pills failed:", err);
                      setSavedLabels((prev) => {
                        const next = new Set(prev);
                        next.delete(m.label);
                        return next;
                      });
                    }
                  }}
                  disabled={savedLabels.has(m.label)}
                  className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition disabled:opacity-50"
                  title="Save this photo to My Pills -- future scans of this pill are matched against your own photo"
                >
                  {savedLabels.has(m.label) ? "📌 Saved" : "📌 Save to My Pills"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Fallback for when the right pill genuinely isn't in the top matches
          above -- describe its color/shape/imprint/score marks instead and
          search the same metadata directly (no photo similarity involved). */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <button
          onClick={() => setShowAppearanceSearch((v) => !v)}
          className="w-full text-center text-sm font-semibold text-indigo-600"
        >
          {showAppearanceSearch ? "▲ Hide" : "▼ Don't see your pill? Describe its appearance instead"}
        </button>
        {showAppearanceSearch && (
          <div className="mt-4">
            <PillSearchPanel compact allowNameSearch={false} />
          </div>
        )}
      </div>

      {/* Save to My Pills even when the right pill isn't among the matches:
          look it up by name and attach this photo to it. That's exactly the
          case My Pills fixes -- next time, this photo is the reference. */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <button
          onClick={() => setShowSaveSearch((v) => !v)}
          className="w-full text-center text-sm font-semibold text-indigo-600"
        >
          {showSaveSearch ? "▲ Hide" : "📌 Know what this pill is? Save it to My Pills"}
        </button>
        {showSaveSearch && (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-slate-500">
              Search for your medication and tap &quot;Save as my pill&quot;. This photo becomes its reference, so the
              next scan of this pill is matched against your own photo.
            </p>
            {savedFromSearch && (
              <p className="text-sm text-emerald-700 font-medium">✓ Saved {savedFromSearch} to My Pills.</p>
            )}
            <PillSearchPanel
              compact
              defaultMode="name"
              selectLabel="📌 Save as my pill"
              onSelect={async (r) => {
                try {
                  await onSaveFromSearch(r);
                  setSavedFromSearch(r.name || r.label);
                } catch (err) {
                  console.error("Saving to My Pills failed:", err);
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Feedback: this is currently the ONLY source of real phone-photo
          accuracy data this app collects -- every accuracy number behind
          this model was measured on curated/studio-style photos, not real
          user scans. Keep this low-friction; don't block or nag. */}
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-center space-y-2">
        {feedbackState === "sent" ? (
          <p className="text-sm text-emerald-700 font-medium">Thanks — that helps us improve matches.</p>
        ) : (
          <>
            <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Was this match right?</p>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => sendFeedback(true, matches[0]?.label)}
                disabled={feedbackState === "sending" || !predictionId}
                className="px-4 py-2 bg-emerald-100 hover:bg-emerald-200 text-emerald-800 font-bold rounded-xl text-xs transition disabled:opacity-50"
              >
                ✓ Yes, correct
              </button>
              <button
                onClick={() => sendFeedback(false)}
                disabled={feedbackState === "sending" || !predictionId}
                className="px-4 py-2 bg-red-100 hover:bg-red-200 text-red-800 font-bold rounded-xl text-xs transition disabled:opacity-50"
              >
                ✗ None of these
              </button>
            </div>
            {feedbackState === "error" && (
              <p className="text-xs text-slate-400">Couldn&apos;t send feedback — no worries, continue as normal.</p>
            )}
          </>
        )}
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
