// src/components/Scanner.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage, identifyPill, readImprint, submitFeedback, type PillLook, type PillMatch, type SearchResult } from "@/lib/api";
import { addReferencePill, deleteScan, getMedications, getReferencePills, type ScanRecord } from "@/lib/db";
import { saveScan, thumbFromUrl } from "@/lib/scanLog";
import { scoreMyPills, judgeMyPillMatch, type MyPillVerdict } from "@/lib/myPills";
import { fullSafetyCheck } from "@/lib/safety";
import { speak, vibrate } from "./AudioAlert";
import { logTelemetry } from "@/lib/telemetry";
import ImageCapture from "./ImageCapture";
import PillSearchPanel from "./PillSearchPanel";
import PillThumb from "./PillThumb";
import AddToMedsButton from "./AddToMedsButton";
import LookPicker from "./LookPicker";

type Stage = "capture-front" | "capture-back" | "imprint" | "identifying" | "results";
type ImprintSource = "user" | "ocr" | null;

export default function Scanner() {
  const [stage, setStage] = useState<Stage>("capture-front");
  const [statusMsg, setStatusMsg] = useState("Analyzing pill features...");
  const [matches, setMatches] = useState<PillMatch[] | null>(null);
  const [lowConfidence, setLowConfidence] = useState(false);
  const [ocrImprintRead, setOcrImprintRead] = useState<string | null>(null);
  const [scanTime, setScanTime] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [frontCanvas, setFrontCanvas] = useState<HTMLCanvasElement | null>(null);
  const [backCanvas, setBackCanvas] = useState<HTMLCanvasElement | null>(null);
  const [imprintSide1, setImprintSide1] = useState("");
  const [imprintSide2, setImprintSide2] = useState("");
  const [imprintReading, setImprintReading] = useState(false);
  const [imprintSuggestion, setImprintSuggestion] = useState<{ side_1: string; side_2: string } | null>(null);
  const [imprintSource, setImprintSource] = useState<ImprintSource>(null);
  const [imprintFound, setImprintFound] = useState<boolean | null>(null);
  const [predictionId, setPredictionId] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [queryEmbeddings, setQueryEmbeddings] = useState<number[][] | null>(null);
  const [myPillVerdict, setMyPillVerdict] = useState<MyPillVerdict>(null);
  const [look, setLook] = useState<PillLook>({ colors: [], shape: null });
  const [lookSuggestion, setLookSuggestion] = useState<PillLook | null>(null);

  const handleFrontCaptured = (canvas: HTMLCanvasElement) => {
    setFrontCanvas(canvas);
    setPreviewUrl(canvas.toDataURL());
    setStage("capture-back");
  };

  // After the photos: read the imprint from them as a SUGGESTION only. The
  // boxes are never pre-filled: free OCR reads pill imprints correctly only
  // ~25% of the time, and in testing an unchecked wrong read pushed the
  // right pill from #1 to past #20 (a confirmed imprint is weighted
  // heavily). The user has to look at the pill and choose to use it.
  const handleBackDone = async (front: HTMLCanvasElement, back: HTMLCanvasElement | null) => {
    setBackCanvas(back);
    setImprintSide1("");
    setImprintSide2("");
    setImprintSuggestion(null);
    setLook({ colors: [], shape: null });
    setLookSuggestion(null);
    setStage("imprint");
    setImprintReading(true);
    try {
      const read = await readImprint(front, back);
      if (read.side_1 || read.side_2) setImprintSuggestion({ side_1: read.side_1, side_2: read.side_2 });
      if (read.colors?.length || read.shape) setLookSuggestion({ colors: read.colors ?? [], shape: read.shape ?? null });
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
      result = await identifyPill(front, 10, back, imprint, look);
    } catch (err: any) {
      console.error("Scan failed:", err);
      setScanError(
        errorMessage(err)
      );
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
    setImprintFound(result.imprintFound);
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

    if (result.matches.length) vibrate([100, 50, 100]);
  };

  const resetScanner = () => {
    setMatches(null);
    setLowConfidence(false);
    setOcrImprintRead(null);
    setScanTime(null);
    setPreviewUrl(null);
    setFrontCanvas(null);
    setBackCanvas(null);
    setImprintSide1("");
    setImprintSide2("");
    setImprintSuggestion(null);
    setImprintSource(null);
    setPredictionId(null);
    setScanError(null);
    setQueryEmbeddings(null);
    setMyPillVerdict(null);
    setLook({ colors: [], shape: null });
    setLookSuggestion(null);
    setStage("capture-front");
  };

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
          {!imprintReading && imprintSuggestion && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-center space-y-2">
              <p className="text-sm text-amber-900">
                Our camera thinks it says{" "}
                <span className="font-mono font-bold">
                  {[imprintSuggestion.side_1, imprintSuggestion.side_2].filter(Boolean).join(" / ")}
                </span>
              </p>
              <p className="text-xs text-amber-800">
                This reading is often wrong. Only use it if it matches what you see on the pill.
              </p>
              <button
                type="button"
                onClick={() => {
                  setImprintSide1(imprintSuggestion.side_1);
                  setImprintSide2(imprintSuggestion.side_2);
                }}
                className="px-4 py-1.5 bg-amber-200 hover:bg-amber-300 text-amber-900 font-semibold rounded-lg text-xs"
              >
                It matches — use it
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-slate-600">
              Side 1
              <input
                type="text"
                value={imprintSide1}
                onChange={(e) => setImprintSide1(e.target.value)}
                placeholder="e.g. L"
                maxLength={30}
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
                maxLength={30}
                className="mt-1 w-full px-3 py-3 border border-slate-300 rounded-xl text-lg font-mono uppercase"
                autoCapitalize="characters"
              />
            </label>
          </div>
          <div className="border-t border-slate-200 pt-4">
            <LookPicker value={look} onChange={setLook} suggestion={lookSuggestion} reading={imprintReading} />
          </div>
          <button
            type="submit"
            className="w-full px-4 py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl transition shadow-lg text-lg"
          >
            Find my pill
          </button>
          <button
            type="button"
            onClick={() => runIdentify(frontCanvas, backCanvas, "")}
            className="w-full py-2 text-base text-slate-600 hover:text-slate-800 underline"
          >
            My pill has no letters or numbers — find it
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
          scanTime={scanTime}
          previewUrl={previewUrl}
          predictionId={predictionId}
          imprintSource={imprintSource}
          imprintFound={imprintFound}
          lookUsed={look}
          myPillVerdict={myPillVerdict}
          onChangeImprint={() => setStage("imprint")}
          onSaveReference={saveAsReference}
          onSaveFromSearch={saveFromSearch}
          onRetake={resetScanner}
        />
      )}
    </div>
  );
}

// How alike the photos look, in words. Scores are cosine similarity between
// the user's photo and the pill's reference photos; 0.45 is the server's
// low-confidence cut-off.
function likeness(score: number): { text: string; tone: string } {
  if (score >= 0.75) return { text: "Looks very similar", tone: "text-emerald-700" };
  if (score >= 0.6) return { text: "Looks similar", tone: "text-emerald-700" };
  if (score >= 0.45) return { text: "Some resemblance", tone: "text-amber-700" };
  return { text: "Weak resemblance", tone: "text-slate-500" };
}

// A listing with no drug name on file shows that plainly, never a bare code.
const nameOf = (m: PillMatch) => m.drug_name || `Name not on file (NDC ${m.ndc || m.label})`;

function lookOf(m: PillMatch) {
  return { imprint: m.imprint, color: m.color, shape: m.shape, scoreMarks: m.score_marks };
}

function describe(m: PillMatch): string {
  return [m.imprint && `Imprint ${m.imprint}`, m.color, m.shape].filter(Boolean).join(" · ");
}

function ResultsView({
  matches,
  lowConfidence,
  ocrImprintRead,
  scanTime,
  previewUrl,
  predictionId,
  imprintSource,
  imprintFound,
  lookUsed,
  myPillVerdict,
  onChangeImprint,
  onSaveReference,
  onSaveFromSearch,
  onRetake,
}: {
  matches: PillMatch[];
  lowConfidence: boolean;
  ocrImprintRead: string | null;
  scanTime: number | null;
  previewUrl: string | null;
  predictionId: string | null;
  imprintSource: ImprintSource;
  imprintFound: boolean | null;
  lookUsed: PillLook;
  myPillVerdict: MyPillVerdict;
  onChangeImprint: () => void;
  onSaveReference: (match: PillMatch) => Promise<void>;
  onSaveFromSearch: (result: SearchResult) => Promise<void>;
  onRetake: () => void;
}) {
  const [chosen, setChosen] = useState<PillMatch | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [notHere, setNotHere] = useState(false);
  const [comparing, setComparing] = useState<number | null>(null);
  const [savedLabels, setSavedLabels] = useState<Set<string>>(new Set());
  const [savedFromSearch, setSavedFromSearch] = useState<string | null>(null);
  const [safetyNotes, setSafetyNotes] = useState<string[] | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);

  const first = matches.slice(0, 5);
  const more = matches.slice(5, 10);
  const showMatchedImprint = imprintSource === "user";

  // Every answer goes back to the server (best-effort). The confirmed photo
  // becomes that pill's reference picture, and only the latest answer for
  // a scan counts, so changing your mind is fine.
  async function sendFeedback(correct: boolean, label?: string) {
    const key = correct ? `yes:${label}` : "no";
    if (!predictionId || lastSent === key) return;
    setLastSent(key);
    try {
      await submitFeedback(predictionId, correct, label);
    } catch (err) {
      console.error("Feedback submission failed (non-fatal):", err);
    }
  }

  // The picked pill goes into the scan history (Safety tab); going back to
  // the matches takes it out again.
  const scanLog = useRef<Promise<ScanRecord | null>>(Promise.resolve(null));
  function logChoice(m: PillMatch | null) {
    scanLog.current = scanLog.current
      .then(async (prev) => {
        if (prev) await deleteScan(prev.id);
        if (!m) return null;
        return saveScan({
          source: "identify",
          outcome: "identified",
          drugName: m.drug_name,
          ndc: m.ndc ?? undefined,
          confirmedByUser: true,
          photoDataUrl: previewUrl ? await thumbFromUrl(previewUrl) : "",
        });
      })
      .catch((err) => {
        console.error("Updating the scan history failed (non-fatal):", err);
        return null;
      });
  }

  function choose(m: PillMatch) {
    setChosen(m);
    logChoice(m);
    setComparing(null);
    setNotHere(false);
    vibrate([60, 40, 60]);
    sendFeedback(true, m.label);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Safety check for the pill the user picked, against the medicines they
  // already take. Best-effort: a failure just shows nothing.
  useEffect(() => {
    if (!chosen) return;
    let cancelled = false;
    setSafetyNotes(null);
    (async () => {
      if (!chosen.drug_name) {
        if (!cancelled) setSafetyNotes(["We don't have this medicine's name on file, so it can't be checked against your other medicines. Ask your pharmacist."]);
        return;
      }
      try {
        const name = chosen.drug_name;
        const existing = (await getMedications()).map((m) => m.drugName);
        const { beers, interactions, duplicates } = await fullSafetyCheck(name, existing);
        const notes: string[] = [];
        for (const i of interactions) {
          const other = i.drug_a === name ? i.drug_b : i.drug_a;
          notes.push(`With your ${other}: ${i.description}`);
        }
        for (const d of duplicates) {
          const others = d.drugs.filter((x) => x !== name).join(", ");
          notes.push(`Your ${others} also contains ${d.ingredient}. Taking both can mean too much of it.`);
        }
        if (beers) notes.push(`Caution for older adults (${beers.risk_level} risk): ${beers.rationale} ${beers.recommendation}`);
        if (!cancelled) setSafetyNotes(notes);
      } catch (err) {
        console.error("Safety check failed (non-fatal):", err);
        if (!cancelled) setSafetyNotes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chosen]);

  async function saveRef(m: PillMatch) {
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
  }

  // ---- After the user picked their pill -------------------------------
  if (chosen) {
    return (
      <div className="w-full space-y-5 max-w-xl mx-auto pb-12">
        <div className="bg-emerald-50 border-2 border-emerald-400 rounded-2xl p-5 space-y-4">
          <p className="text-sm font-bold text-emerald-800 uppercase tracking-wider">✓ Your pill</p>
          <div className="grid grid-cols-2 gap-3">
            <PhotoBox label="Your photo" src={previewUrl} />
            <div className="text-center">
              <p className="text-xs font-bold text-slate-500 mb-1">Reference</p>
              <PillThumb url={chosen.reference_image_url} kind={chosen.reference_image_kind} alt={nameOf(chosen)} look={lookOf(chosen)} className="w-full aspect-square" />
            </div>
          </div>
          <div>
            <p className="text-2xl font-bold text-slate-900 break-words">{nameOf(chosen)}</p>
            {describe(chosen) && <p className="text-base text-slate-700 mt-1 break-words">{describe(chosen)}</p>}
            {chosen.also_sold_as.length > 0 && (
              <p className="text-sm text-slate-600 mt-1 break-words">Same pill also sold as: {chosen.also_sold_as.join(", ")}</p>
            )}
            {chosen.ndc && <p className="text-xs text-slate-400 font-mono mt-1 truncate">NDC {chosen.ndc}</p>}
          </div>
          <button
            onClick={() => speak(`${nameOf(chosen)}. ${describe(chosen)}`)}
            className="w-full py-3 bg-white border border-emerald-300 text-emerald-800 font-bold rounded-xl"
          >
            🔊 Read aloud
          </button>
        </div>

        {safetyNotes === null ? (
          <p className="text-sm text-slate-500 text-center">Checking against your medicines…</p>
        ) : safetyNotes.length > 0 ? (
          <div className="bg-red-50 border-2 border-red-300 rounded-2xl p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-base font-bold text-red-900">⚠ Talk to your doctor or pharmacist</p>
              <button onClick={() => speak(safetyNotes.join(". "))} className="shrink-0 px-2 py-1 text-red-800" aria-label="Read warnings aloud">
                🔊
              </button>
            </div>
            <ul className="space-y-2">
              {safetyNotes.map((n) => (
                <li key={n} className="text-sm text-red-900 leading-snug">• {n}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-emerald-700 text-center">✓ No known problems with the medicines you have added.</p>
        )}

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <AddToMedsButton drugName={chosen.drug_name || `NDC ${chosen.ndc || chosen.label}`} ndc={chosen.ndc} />
          <button
            onClick={() => saveRef(chosen)}
            disabled={savedLabels.has(chosen.label) || !previewUrl}
            className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-xl disabled:opacity-60"
          >
            {savedLabels.has(chosen.label) ? "📌 Saved to My Pills" : "📌 Save my photo to My Pills"}
          </button>
          <p className="text-xs text-slate-500 text-center">
            Saving your photo helps the next scan of this pill find it instantly.
          </p>
        </div>

        <button onClick={onRetake} className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white text-lg font-bold rounded-2xl">
          📷 Scan another pill
        </button>
        <button
          onClick={() => {
            setChosen(null);
            logChoice(null);
          }}
          className="w-full text-base text-indigo-700 underline"
        >
          That&apos;s not my pill — go back to the matches
        </button>
      </div>
    );
  }

  // ---- Choosing ---------------------------------------------------------
  const visible = showMore ? [...first, ...more] : first;
  return (
    <div className="w-full space-y-5 max-w-xl mx-auto pb-12">
      <div className="flex items-center gap-4 bg-white border border-slate-200 rounded-2xl p-4">
        <PhotoBox label="Your photo" src={previewUrl} className="w-24" />
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-slate-900">Which one is your pill?</h2>
          <p className="text-sm text-slate-600 mt-1">
            Compare the pictures and the letters on your pill. Tap <strong>This is my pill</strong> on the one that matches.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
        {showMatchedImprint && ocrImprintRead ? (
          <span>
            Searched with imprint <span className="font-mono font-bold text-slate-900">{ocrImprintRead}</span>
          </span>
        ) : (
          <span>Searched by appearance only (no imprint).</span>
        )}
        {(lookUsed.colors.length > 0 || lookUsed.shape) && (
          <span>
            · {[...lookUsed.colors, lookUsed.shape].filter(Boolean).map((w) => w!.charAt(0) + w!.slice(1).toLowerCase()).join(", ")}
          </span>
        )}
        <button onClick={onChangeImprint} className="text-indigo-700 font-semibold underline">
          {showMatchedImprint && ocrImprintRead ? "Change" : "Add the imprint"}
        </button>
        {scanTime !== null && <span className="text-xs text-slate-400 ml-auto">{(scanTime / 1000).toFixed(1)} s</span>}
      </div>

      {myPillVerdict && (
        <div className={`rounded-2xl p-4 border-2 ${myPillVerdict.kind === "strong" ? "bg-emerald-50 border-emerald-400" : "bg-amber-50 border-amber-300"}`}>
          <p className={`text-sm font-bold ${myPillVerdict.kind === "strong" ? "text-emerald-800" : "text-amber-800"}`}>
            {myPillVerdict.kind === "strong" ? "✓ Looks like a pill you saved" : "Might be a pill you saved"}
          </p>
          <div className="flex items-center gap-3 mt-2">
            <img
              src={myPillVerdict.match.pill.photoDataUrl}
              alt={myPillVerdict.match.pill.drugName}
              className="w-16 h-16 rounded-xl border border-slate-200 object-contain bg-white p-1 shrink-0"
            />
            <div className="min-w-0">
              <p className="font-bold text-slate-900 break-words">{myPillVerdict.match.pill.drugName}</p>
              <p className="text-xs text-slate-600">
                Your photo saved {new Date(myPillVerdict.match.pill.savedAt).toLocaleDateString()}
              </p>
            </div>
          </div>
          {myPillVerdict.runnerUp && (
            <p className="text-sm text-amber-900 mt-2">
              Also close: <strong>{myPillVerdict.runnerUp.pill.drugName}</strong>. These look alike — check carefully.
            </p>
          )}
        </div>
      )}

      {imprintSource === "user" && imprintFound === false && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4">
          <p className="text-base font-bold text-amber-900">No pill has the imprint &quot;{ocrImprintRead}&quot;</p>
          <p className="text-sm text-amber-900 mt-1">
            Check for mix-ups like 0 and O, 1 and I, 5 and S, then tap Change. The matches below use the photo only.
          </p>
        </div>
      )}
      {lowConfidence && (
        <div className="bg-red-50 border-2 border-red-300 rounded-2xl p-4">
          <p className="text-base font-bold text-red-900">⚠ No close match</p>
          <p className="text-sm text-red-900 mt-1">
            None of these look very much like your photo. Adding the imprint or retaking the photo in good light usually
            helps. Don&apos;t take a pill you can&apos;t identify — ask a pharmacist.
          </p>
        </div>
      )}

      {matches.length === 0 && (
        <p className="text-base text-slate-700 text-center py-6">No matches found. Try the options below.</p>
      )}

      <div className="space-y-4">
        {visible.map((m, idx) => (
          <MatchCard
            key={m.label}
            match={m}
            rank={idx + 1}
            showImprintMatch={showMatchedImprint}
            onChoose={() => choose(m)}
            onCompare={() => setComparing(idx)}
          />
        ))}
      </div>

      {more.length > 0 && (
        <button
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="w-full py-4 bg-white border-2 border-slate-300 text-slate-800 text-base font-bold rounded-2xl"
        >
          {showMore ? "▲ Show fewer matches" : `▼ Not here? Show ${more.length} more matches`}
        </button>
      )}

      {/* Everything for "my pill isn't in the list", in one place. */}
      <div className="bg-white border-2 border-slate-200 rounded-2xl p-4 space-y-3">
        {!notHere ? (
          <button
            onClick={() => {
              setNotHere(true);
              sendFeedback(false);
            }}
            className="w-full py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-base font-bold rounded-xl"
          >
            ✗ My pill isn&apos;t here
          </button>
        ) : (
          <NotHerePanel
            onRetake={onRetake}
            onChangeImprint={onChangeImprint}
            hasImprint={showMatchedImprint && !!ocrImprintRead}
            savedFromSearch={savedFromSearch}
            onSaveFromSearch={async (r) => {
              try {
                await onSaveFromSearch(r);
                setSavedFromSearch(r.name || r.label);
              } catch (err) {
                console.error("Saving to My Pills failed:", err);
              }
            }}
          />
        )}
      </div>

      <button onClick={onRetake} className="w-full py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-2xl">
        📷 Scan another pill
      </button>

      {comparing !== null && visible[comparing] && (
        <CompareModal
          matches={visible}
          index={comparing}
          previewUrl={previewUrl}
          showImprintMatch={showMatchedImprint}
          onIndex={setComparing}
          onChoose={choose}
          onClose={() => setComparing(null)}
        />
      )}
    </div>
  );
}

function PhotoBox({ label, src, className = "w-full" }: { label: string; src: string | null; className?: string }) {
  return (
    <div className={`${className} shrink-0 text-center`}>
      <p className="text-xs font-bold text-slate-500 mb-1">{label}</p>
      {src ? (
        <img src={src} alt={label} className="w-full aspect-square object-contain rounded-xl border border-slate-200 bg-white" />
      ) : (
        <div className="w-full aspect-square rounded-xl bg-slate-100" />
      )}
    </div>
  );
}

function MatchCard({
  match: m,
  rank,
  showImprintMatch,
  onChoose,
  onCompare,
}: {
  match: PillMatch;
  rank: number;
  showImprintMatch: boolean;
  onChoose: () => void;
  onCompare: () => void;
}) {
  const like = likeness(m.score);
  const imprintMatches = showImprintMatch && m.imprint_match_score >= 0.99;
  return (
    <div className={`rounded-2xl border-2 bg-white p-4 shadow-sm space-y-3 ${imprintMatches ? "border-emerald-300" : "border-slate-200"}`}>
      <div className="flex gap-4">
        <button onClick={onCompare} className="shrink-0 relative" aria-label={`Compare ${nameOf(m)} with your photo`}>
          <PillThumb url={m.reference_image_url} kind={m.reference_image_kind} alt={nameOf(m)} look={lookOf(m)} className="w-28 h-28" />
          <span className="absolute -top-2 -left-2 w-7 h-7 rounded-full bg-slate-800 text-white text-sm font-bold flex items-center justify-center">
            {rank}
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold text-slate-900 leading-snug break-words">{nameOf(m)}</p>
          {describe(m) && <p className="text-sm text-slate-700 mt-0.5 break-words">{describe(m)}</p>}
          {imprintMatches && <p className="text-sm font-bold text-emerald-700 mt-1">✓ Imprint matches yours</p>}
          <p className={`text-sm font-semibold mt-1 ${like.tone}`}>
            {like.text} <span className="font-normal text-slate-400">({Math.round(m.score * 100)}%)</span>
          </p>
          {m.also_sold_as.length > 0 && (
            <p className="text-xs text-slate-500 mt-1 line-clamp-2 break-words">Also sold as: {m.also_sold_as.join(", ")}</p>
          )}
        </div>
      </div>
      <div className="grid grid-cols-5 gap-2">
        <button
          onClick={onChoose}
          className="col-span-3 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white text-base font-bold rounded-xl"
        >
          ✓ This is my pill
        </button>
        <button onClick={onCompare} className="col-span-2 py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-base font-bold rounded-xl">
          🔍 Compare
        </button>
      </div>
    </div>
  );
}

// Full-screen side-by-side check: your photo above, the reference below,
// with arrows to step through the matches.
function CompareModal({
  matches,
  index,
  previewUrl,
  showImprintMatch,
  onIndex,
  onChoose,
  onClose,
}: {
  matches: PillMatch[];
  index: number;
  previewUrl: string | null;
  showImprintMatch: boolean;
  onIndex: (i: number) => void;
  onChoose: (m: PillMatch) => void;
  onClose: () => void;
}) {
  const m = matches[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && index < matches.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, matches.length, onClose, onIndex]);

  return (
    <div className="fixed inset-0 z-[60] bg-slate-900/70 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-md max-h-[100dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-slate-500">
            Match {index + 1} of {matches.length}
          </p>
          <button onClick={onClose} className="px-3 py-1.5 bg-slate-100 rounded-xl text-base font-bold text-slate-700" aria-label="Close">
            ✕ Close
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <PhotoBox label="Your photo" src={previewUrl} />
          <div className="text-center">
            <p className="text-xs font-bold text-slate-500 mb-1">Match {index + 1}</p>
            <PillThumb url={m.reference_image_url} kind={m.reference_image_kind} alt={nameOf(m)} look={lookOf(m)} className="w-full aspect-square" />
          </div>
        </div>
        <div>
          <p className="text-xl font-bold text-slate-900 break-words">{nameOf(m)}</p>
          {describe(m) && <p className="text-base text-slate-700 break-words">{describe(m)}</p>}
          {showImprintMatch && m.imprint_match_score >= 0.99 && (
            <p className="text-sm font-bold text-emerald-700 mt-1">✓ Imprint matches yours</p>
          )}
          {m.reference_image_kind === "package" && (
            <p className="text-xs text-slate-500 mt-1">Only a package photo is available for this pill. Check the imprint and color.</p>
          )}
        </div>
        <button onClick={() => onChoose(m)} className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white text-lg font-bold rounded-2xl">
          ✓ This is my pill
        </button>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => onIndex(index - 1)}
            disabled={index === 0}
            className="py-3 bg-slate-100 text-slate-800 font-bold rounded-xl disabled:opacity-40"
          >
            ← Previous
          </button>
          <button
            onClick={() => onIndex(index + 1)}
            disabled={index === matches.length - 1}
            className="py-3 bg-slate-100 text-slate-800 font-bold rounded-xl disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}

function NotHerePanel({
  onRetake,
  onChangeImprint,
  hasImprint,
  savedFromSearch,
  onSaveFromSearch,
}: {
  onRetake: () => void;
  onChangeImprint: () => void;
  hasImprint: boolean;
  savedFromSearch: string | null;
  onSaveFromSearch: (r: SearchResult) => Promise<void>;
}) {
  const [open, setOpen] = useState<"appearance" | "name" | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-base font-bold text-slate-900">Let&apos;s find it another way</p>
      <button onClick={onChangeImprint} className="w-full py-3.5 bg-indigo-600 text-white text-base font-bold rounded-xl text-left px-4">
        🔤 {hasImprint ? "Check the letters/numbers I typed" : "Type the letters/numbers on the pill"}
        <span className="block text-xs font-normal opacity-90">The best way to find a pill</span>
      </button>
      <button onClick={onRetake} className="w-full py-3.5 bg-slate-100 text-slate-800 text-base font-bold rounded-xl text-left px-4">
        📷 Retake the photo
        <span className="block text-xs font-normal text-slate-500">Good light, plain background, pill filling the box</span>
      </button>
      <button
        onClick={() => setOpen(open === "appearance" ? null : "appearance")}
        aria-expanded={open === "appearance"}
        className="w-full py-3.5 bg-slate-100 text-slate-800 text-base font-bold rounded-xl text-left px-4"
      >
        🎨 Describe its color and shape
      </button>
      {open === "appearance" && <PillSearchPanel compact allowNameSearch={false} />}
      <button
        onClick={() => setOpen(open === "name" ? null : "name")}
        aria-expanded={open === "name"}
        className="w-full py-3.5 bg-slate-100 text-slate-800 text-base font-bold rounded-xl text-left px-4"
      >
        📌 I know its name — save my photo
        <span className="block text-xs font-normal text-slate-500">Next time this pill is recognized from your photo</span>
      </button>
      {open === "name" && (
        <div className="space-y-2">
          {savedFromSearch && <p className="text-sm text-emerald-700 font-semibold">✓ Saved {savedFromSearch} to My Pills.</p>}
          <PillSearchPanel compact defaultMode="name" selectLabel="📌 Save as my pill" onSelect={onSaveFromSearch} />
        </div>
      )}
    </div>
  );
}
