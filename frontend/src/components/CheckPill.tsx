"use client";

import { useEffect, useRef, useState } from "react";
import { embedCanvases, fetchCohort } from "@/lib/api";
import {
  getDoses, getMedications, getReferencePills, localDate, medKey, setDoseStatus, updateReferencePill,
  type Medication, type ReferencePill, type ScheduleEntry,
} from "@/lib/db";
import { checkMyPill, MY_PILLS, rankMyMedicines, withLearnedScan, type CheckResult, type MedMatch } from "@/lib/myPills";
import { reviseScan, saveScan, thumbFromCanvas, type NewScan } from "@/lib/scanLog";
import { deleteScan, type ScanRecord } from "@/lib/db";
import { doseApplies, SLOTS, slotState } from "@/lib/slots";
import ImageCapture from "./ImageCapture";
import { speak, vibrate } from "./AudioAlert";

type Stage = "front" | "back" | "back2" | "checking" | "result";

// "Which of my medicines is this?" -- the main check for a senior. Compares
// the photo only with the patient's own saved pills (set up with a
// caregiver/pharmacist), and says plainly when it isn't one of them.
export default function CheckPill({
  onSetup,
  onAddNew,
  onIdentify,
}: {
  onSetup: () => void;
  onAddNew: (front: HTMLCanvasElement, back: HTMLCanvasElement | null) => void;
  onIdentify: () => void;
}) {
  const [pills, setPills] = useState<ReferencePill[] | null>(null);
  const [stage, setStage] = useState<Stage>("front");
  const [front, setFront] = useState<HTMLCanvasElement | null>(null);
  const [back, setBack] = useState<HTMLCanvasElement | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<MedMatch | null>(null);
  // The pill as it was before this scan was learned, to undo on "That's not right".
  const [beforeLearn, setBeforeLearn] = useState<ReferencePill | null>(null);
  // This scan's entry in the scan history (Safety tab); later answers
  // ("it's this one", "it's neither") update it in order.
  const scanLog = useRef<Promise<ScanRecord | null>>(Promise.resolve(null));
  const logScan = (changes: Partial<NewScan>) => {
    scanLog.current = scanLog.current
      .then((r) => (r ? reviseScan(r, changes) : null))
      .catch((err) => {
        console.error("Updating the scan history failed (non-fatal):", err);
        return null;
      });
  };

  useEffect(() => {
    (async () => {
      const ps = await getReferencePills();
      setPills(ps);
      // Pills saved before scores were normalized: fetch their statistics
      // once (no photo needed). Until then they're compared the plain way.
      let changed = false;
      for (const p of ps) {
        const embs = p.embeddings ?? [];
        const learned = p.learnedEmbeddings ?? [];
        if (embs.length === 0) continue;
        if (p.cohort?.length === embs.length && (p.learnedCohort?.length ?? 0) === learned.length) continue;
        try {
          const stats = await fetchCohort([...embs, ...learned]);
          await updateReferencePill({ ...p, cohort: stats.slice(0, embs.length), learnedCohort: stats.slice(embs.length) });
          changed = true;
        } catch (err) {
          console.error("Couldn't prepare a saved pill (non-fatal):", err);
          break;
        }
      }
      if (changed) setPills(await getReferencePills());
    })();
  }, []);

  const ready = (pills ?? []).filter((p) => p.embeddings && p.embeddings.length > 0);

  // `retry`: the same pill again with the other side added -- replaces the
  // earlier one-side entry in the scan history.
  async function check(f: HTMLCanvasElement, b: HTMLCanvasElement | null, retry = false) {
    if (retry) {
      const prev = scanLog.current;
      scanLog.current = prev.then((r) => (r ? deleteScan(r.id).then(() => null) : null)).catch(() => null);
    }
    setStage("checking");
    setError(null);
    setConfirmed(null);
    setBeforeLearn(null);
    try {
      const emb = await embedCanvases(f, b);
      const { ranked, mode } = rankMyMedicines(emb, ready);
      let res = checkMyPill(ranked, MY_PILLS[mode]);
      // The safety limits were measured with both sides photographed. With
      // only one side, never say "This is your X" -- ask to check the letters.
      if (!b && MY_PILLS.PHOTOS === 2 && res.kind === "match") res = { kind: "check", options: [res.best] };
      setResult(res);
      const top = res.kind === "match" ? res.best : res.kind === "check" ? res.options[0] : null;
      const entry: NewScan = {
        source: "check",
        outcome: res.kind === "match" ? "yours" : res.kind === "check" ? "check" : "not-yours",
        drugName: top?.pill.drugName ?? null,
        ndc: top?.pill.ndc,
        confirmedByUser: false,
        photoDataUrl: thumbFromCanvas(f),
      };
      scanLog.current = scanLog.current
        .then(() => saveScan(entry))
        .catch((err) => {
          console.error("Saving to the scan history failed (non-fatal):", err);
          return null;
        });
      setStage("result");
      if (res.kind === "match") {
        vibrate([80, 40, 80]);
        setConfirmed(res.best);
        // Confident match: remember this photo too, so future checks of this
        // pill handle the patient's own lighting and angles better.
        try {
          setBeforeLearn(res.best.pill);
          const learned = withLearnedScan(res.best.pill, emb);
          await updateReferencePill(learned);
          setPills((ps) => (ps ?? []).map((p) => (p.id === learned.id ? learned : p)));
        } catch (err) {
          console.error("Couldn't update the saved pill (non-fatal):", err);
        }
      } else if (res.kind === "none") {
        vibrate([300, 100, 300]);
      }
    } catch (err: any) {
      setError(
        err instanceof TypeError
          ? "Can't reach the Pill ID server. Check your internet connection and try again."
          : err?.message || String(err)
      );
      setStage("front");
    }
  }

  function again() {
    setStage("front");
    setFront(null);
    setBack(null);
    setResult(null);
    setConfirmed(null);
  }

  if (pills === null) return null;

  if (ready.length === 0) {
    return (
      <div className="max-w-xl mx-auto space-y-4 text-center py-6">
        <p className="text-5xl">💊</p>
        <h2 className="text-2xl font-bold text-slate-900">Set up your medicines first</h2>
        <p className="text-base text-slate-600">
          Take a photo of each medicine you take, together with a caregiver or pharmacist. After that, the app can tell
          you which of your medicines a pill is, or warn you if it isn&apos;t one of them.
        </p>
        {pills.length > 0 && (
          <p className="text-sm text-amber-800">Your saved pills are still being prepared. Connect to the internet and open My Medicines.</p>
        )}
        <button onClick={onSetup} className="w-full py-4 bg-indigo-600 text-white text-lg font-bold rounded-2xl">
          Set up my medicines
        </button>
        <button onClick={onIdentify} className="w-full py-3 text-base text-indigo-700 underline">
          Identify an unknown pill instead
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto pb-12">
      {stage === "front" && (
        <>
          <div className="mb-4">
            <h2 className="text-2xl font-bold text-slate-900">Check a pill</h2>
            <p className="text-base text-slate-600">
              Take a photo and we&apos;ll tell you which of your {ready.length} medicines it is.
            </p>
          </div>
          {error && (
            <div className="mb-4 bg-red-50 border-2 border-red-300 rounded-2xl p-4">
              <p className="text-base font-bold text-red-900">Couldn&apos;t check the pill</p>
              <p className="text-sm text-red-800 mt-1">{error}</p>
            </div>
          )}
          <ImageCapture
            sideLabel="front"
            onImageReady={(c) => {
              setFront(c);
              setStage("back");
            }}
            onCancel={() => setStage("front")}
          />
          <button onClick={onIdentify} className="w-full mt-4 py-3 text-base text-indigo-700 underline">
            Identify a pill that isn&apos;t one of mine
          </button>
        </>
      )}

      {stage === "back" && front && (
        <ImageCapture
          sideLabel="back"
          allowSkip
          onSkip={() => check(front, null)}
          onImageReady={(c) => {
            setBack(c);
            check(front, c);
          }}
          onCancel={() => setStage("front")}
        />
      )}

      {stage === "back2" && front && (
        <>
          <p className="mb-3 text-lg font-bold text-slate-900">Turn the pill over and take one more photo</p>
          <ImageCapture
            sideLabel="back"
            onImageReady={(c) => {
              setBack(c);
              check(front, c, true);
            }}
            onCancel={() => setStage("result")}
          />
        </>
      )}

      {stage === "checking" && (
        <div className="text-center py-16">
          <p className="text-4xl animate-pulse">🔍</p>
          <p className="text-lg font-medium text-slate-900 mt-3">Comparing with your medicines…</p>
        </div>
      )}

      {stage === "result" && result && front && (
        <div className="space-y-5">
          {confirmed ? (
            <Confirmed match={confirmed} scan={front.toDataURL()} />
          ) : result.kind === "check" ? (
            <div className="space-y-4">
              <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4">
                <p className="text-xl font-bold text-amber-900">
                  {result.options.length > 1 ? "It could be one of these two" : `Probably your ${result.options[0].pill.drugName}`}
                </p>
                <p className="text-base text-amber-900 mt-1">
                  Look at the letters or numbers on the pill and compare them with your saved photos.
                </p>
              </div>
              <PhotoPair label="Your photo now" src={front.toDataURL()} />
              {!back && (
                <button onClick={() => setStage("back2")} className="w-full py-3.5 bg-indigo-600 text-white text-base font-bold rounded-xl">
                  📷 Add the other side — more accurate
                </button>
              )}
              {result.options.map((o) => (
                <div key={o.key} className="flex gap-3 items-center p-3 bg-white border-2 border-slate-200 rounded-2xl">
                  <img src={o.pill.photoDataUrl} alt={o.pill.drugName} className="w-24 h-24 rounded-xl border border-slate-200 object-contain bg-white shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-lg font-bold text-slate-900 break-words">{o.pill.drugName}</p>
                    {o.pill.imprint && (
                      <p className="text-base text-slate-700">
                        Letters on it: <span className="font-mono font-bold">{o.pill.imprint.replace(/;/g, " ")}</span>
                      </p>
                    )}
                    <button
                      onClick={() => {
                        setConfirmed(o);
                        logScan({ outcome: "yours", drugName: o.pill.drugName, ndc: o.pill.ndc, confirmedByUser: true });
                      }}
                      className="mt-2 w-full py-3 bg-emerald-600 text-white font-bold rounded-xl"
                    >
                      {o.pill.imprint ? "✓ The letters match — it's this one" : "✓ It looks exactly like this one"}
                    </button>
                  </div>
                </div>
              ))}
              <button
                onClick={() => {
                  setResult({ kind: "none", closest: null });
                  logScan({ outcome: "not-yours", drugName: null, ndc: undefined, confirmedByUser: true });
                }}
                className="w-full py-3 bg-slate-100 text-slate-800 font-bold rounded-xl"
              >
                It&apos;s neither of these
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-red-50 border-2 border-red-400 rounded-2xl p-5">
                <p className="text-2xl font-bold text-red-900">⚠ This doesn&apos;t look like any of your medicines</p>
                <p className="text-base text-red-900 mt-2">
                  Don&apos;t take it until you know what it is. Ask your caregiver or pharmacist.
                </p>
                <button
                  onClick={() => speak("This doesn't look like any of your medicines. Don't take it until you know what it is.")}
                  className="mt-3 px-3 py-2 bg-white border border-red-300 text-red-800 font-bold rounded-xl"
                >
                  🔊 Read aloud
                </button>
              </div>
              <PhotoPair label="Your photo" src={front.toDataURL()} />
              {!back && (
                <button onClick={() => setStage("back2")} className="w-full py-4 bg-indigo-600 text-white text-lg font-bold rounded-2xl">
                  📷 Add the other side and check again
                </button>
              )}
              <button onClick={again} className="w-full py-4 bg-slate-100 text-slate-800 text-lg font-bold rounded-2xl">
                📷 Retake the photo
              </button>
              <button onClick={() => onAddNew(front, back)} className="w-full py-3.5 bg-slate-100 text-slate-800 font-bold rounded-xl">
                + It&apos;s a new medicine — add it to my list
              </button>
              <button onClick={onIdentify} className="w-full py-3.5 bg-slate-100 text-slate-800 font-bold rounded-xl">
                🔍 Identify this pill
              </button>
            </div>
          )}
          {(confirmed || result.kind !== "none") && (
            <button onClick={again} className="w-full py-4 bg-indigo-600 text-white text-lg font-bold rounded-2xl">
              📷 Check another pill
            </button>
          )}
          {confirmed && (
            <button
              onClick={async () => {
                if (beforeLearn) {
                  // Forget this scan: it wasn't this pill.
                  await updateReferencePill(beforeLearn).catch(() => {});
                  setPills((ps) => (ps ?? []).map((p) => (p.id === beforeLearn.id ? beforeLearn : p)));
                  setBeforeLearn(null);
                }
                setConfirmed(null);
                setResult({ kind: "none", closest: null });
                logScan({ outcome: "not-yours", drugName: null, ndc: undefined, confirmedByUser: true });
              }}
              className="w-full py-2 text-base text-slate-600 underline"
            >
              That&apos;s not right
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PhotoPair({ label, src }: { label: string; src: string }) {
  return (
    <div className="text-center">
      <p className="text-sm font-bold text-slate-500 mb-1">{label}</p>
      <img src={src} alt={label} className="w-40 h-40 mx-auto rounded-2xl border border-slate-200 object-contain bg-white" />
    </div>
  );
}

// "This is your X": both photos, when it's taken, and -- if that dose is due
// now -- one tap to mark it taken.
function Confirmed({ match, scan }: { match: MedMatch; scan: string }) {
  const [med, setMed] = useState<Medication | null>(null);
  const [due, setDue] = useState<ScheduleEntry | null>(null);
  const [marked, setMarked] = useState(false);
  const name = match.pill.drugName;

  useEffect(() => {
    (async () => {
      const today = localDate();
      const [meds, doses] = await Promise.all([getMedications(), getDoses(today, today)]);
      const m = meds.find((x) => x.key === medKey(match.pill.drugName, match.pill.ndc)) ?? null;
      setMed(m);
      const done = new Set(doses.map((d) => d.scheduleId));
      const e = m?.entries.find((x) => slotState(x.bucket) !== "upcoming" && doseApplies(x, today) && !done.has(x.id));
      setDue(e ?? null);
    })();
  }, [match]);

  return (
    <div className="space-y-4">
      <div className="bg-emerald-50 border-2 border-emerald-400 rounded-2xl p-5">
        <p className="text-sm font-bold text-emerald-800 uppercase tracking-wider">✓ One of your medicines</p>
        <p className="text-3xl font-bold text-slate-900 mt-1 break-words">{name}</p>
        {med && (
          <p className="text-base text-slate-700 mt-1">
            You take it: {med.buckets.map((b) => SLOTS.find((s) => s.key === b)!.label).join(", ")}
          </p>
        )}
        {match.pill.imprint && (
          <p className="text-base text-slate-800 mt-2 bg-white/70 rounded-xl px-3 py-2">
            Double-check: the letters on it should say{" "}
            <span className="font-mono font-bold">{match.pill.imprint.replace(/;/g, " ")}</span>
          </p>
        )}
        <button onClick={() => speak(`This is your ${name}`)} className="mt-3 px-3 py-2 bg-white border border-emerald-300 text-emerald-800 font-bold rounded-xl">
          🔊 Read aloud
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="text-center">
          <p className="text-sm font-bold text-slate-500 mb-1">Your photo now</p>
          <img src={scan} alt="Your photo now" className="w-full aspect-square rounded-2xl border border-slate-200 object-contain bg-white" />
        </div>
        <div className="text-center">
          <p className="text-sm font-bold text-slate-500 mb-1">Saved at setup</p>
          <img src={match.pill.photoDataUrl} alt={name} className="w-full aspect-square rounded-2xl border border-slate-200 object-contain bg-white" />
        </div>
      </div>
      {due && !marked && (
        <button
          onClick={async () => {
            await setDoseStatus(due, localDate(), "taken");
            vibrate([60, 40, 60]);
            setMarked(true);
          }}
          className="w-full py-4 bg-emerald-600 text-white text-lg font-bold rounded-2xl"
        >
          ✓ Mark my {SLOTS.find((s) => s.key === due.bucket)!.label.toLowerCase()} dose as taken
        </button>
      )}
      {marked && <p className="text-center text-lg font-bold text-emerald-700">✓ Marked as taken</p>}
    </div>
  );
}
