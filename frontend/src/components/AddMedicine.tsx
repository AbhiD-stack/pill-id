"use client";

import { useEffect, useState } from "react";
import { contributePhoto, embedCanvases, type Embedded, type SearchResult } from "@/lib/api";
import { addReferencePill, setMedicationPlan } from "@/lib/db";
import type { Frequency } from "@/lib/schedule";
import ImageCapture from "./ImageCapture";
import PillSearchPanel from "./PillSearchPanel";
import SchedulePicker from "./SchedulePicker";
import { vibrate } from "./AudioAlert";

type Step = "front" | "back" | "name" | "times" | "done";
type Chosen = { drugName: string; label: string; ndc?: string; imprint?: string; color?: string; shape?: string };

// Setting up one medicine, ideally with a caregiver or pharmacist and the
// pharmacy bottle in hand: photograph the pill (both sides), say which
// medicine it is (searched by the name on the bottle), and when it's taken. The photo becomes the reference every later check
// is compared with.
export default function AddMedicine({
  initialFront = null,
  initialBack = null,
  onFinished,
  onCancel,
}: {
  initialFront?: HTMLCanvasElement | null;
  initialBack?: HTMLCanvasElement | null;
  onFinished: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>(initialFront ? "name" : "front");
  const [front, setFront] = useState<HTMLCanvasElement | null>(initialFront);
  const [back, setBack] = useState<HTMLCanvasElement | null>(initialBack);
  const [embeddings, setEmbeddings] = useState<Embedded | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  // Share this pill's photo so the app recognizes it for everyone. Clearly
  // explained on screen, and easy to turn off.
  const [share, setShare] = useState(true);

  // As soon as the photos are in: the embeddings the saved pill will be
  // matched with.
  useEffect(() => {
    if (step !== "name" || !front || embeddings) return;
    let cancelled = false;
    (async () => {
      try {
        const e = await embedCanvases(front, back);
        if (!cancelled) setEmbeddings(e);
      } catch (err) {
        console.error("Preparing the photo failed:", err);
        if (!cancelled) {
          setError("Can't reach the Pill ID server, so this photo can't be prepared for checking. You can still save it and it will be prepared later.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, front, back, embeddings]);

  function reset() {
    setStep("front");
    setFront(null);
    setBack(null);
    setEmbeddings(null);
    setChosen(null);
    setError(null);
  }

  async function save(plan: Frequency | null) {
    if (!front || !chosen || saving) return;
    setSaving(true);
    try {
      await addReferencePill({
        drugName: chosen.drugName,
        ndc: chosen.ndc,
        imprint: chosen.imprint,
        color: chosen.color,
        shape: chosen.shape,
        photoDataUrl: front.toDataURL("image/jpeg", 0.9),
        embeddings: embeddings?.embeddings,
        cohort: embeddings?.cohort ?? undefined,
      });
      if (plan) await setMedicationPlan(chosen.drugName, chosen.ndc, plan);
      if (share) {
        // Best-effort, in the background: never blocks or fails the setup.
        contributePhoto(front, back, chosen.label).catch((err) => console.error("Sharing the photo failed (non-fatal):", err));
      }
      vibrate([60, 40, 60]);
      setAdded((a) => [...a, chosen.drugName]);
      setStep("done");
    } catch (err) {
      console.error("Saving the medicine failed:", err);
      setError("Couldn't save on this device. Check that the browser allows site storage and try again.");
    } finally {
      setSaving(false);
    }
  }

  const choose = (c: Chosen) => {
    setChosen(c);
    setStep("times");
  };

  const header = (n: number, title: string, hint?: string) => (
    <div className="mb-4">
      <p className="text-sm font-bold text-indigo-700">Step {n} of 3</p>
      <h2 className="text-2xl font-bold text-slate-900">{title}</h2>
      {hint && <p className="text-base text-slate-600 mt-1">{hint}</p>}
    </div>
  );

  return (
    <div className="max-w-xl mx-auto pb-12">
      {added.length > 0 && step !== "done" && (
        <p className="mb-3 text-sm text-emerald-700 font-semibold">✓ Added so far: {added.join(", ")}</p>
      )}

      {step === "front" && (
        <>
          {header(1, "Photograph the pill", "Put one pill on a plain, light surface in good light. Front side first.")}
          <ImageCapture
            sideLabel="front"
            onImageReady={(c) => {
              setFront(c);
              setStep("back");
            }}
            onCancel={onCancel}
          />
          <button onClick={onCancel} className="w-full mt-4 py-3 text-base text-slate-600 underline">
            Cancel
          </button>
        </>
      )}

      {step === "back" && (
        <>
          {header(1, "Now the other side", "Turn the pill over. This helps tell look-alike pills apart.")}
          <ImageCapture
            sideLabel="back"
            allowSkip
            onSkip={() => setStep("name")}
            onImageReady={(c) => {
              setBack(c);
              setStep("name");
            }}
            onCancel={() => setStep("front")}
          />
        </>
      )}

      {step === "name" && front && (
        <div className="space-y-5">
          {header(2, "Which medicine is it?", "Type the name from the pharmacy bottle and pick the matching one.")}
          <div className="flex gap-3">
            <img src={front.toDataURL()} alt="Front of the pill" className="w-24 h-24 rounded-xl border border-slate-200 object-contain bg-white" />
            {back && <img src={back.toDataURL()} alt="Back of the pill" className="w-24 h-24 rounded-xl border border-slate-200 object-contain bg-white" />}
          </div>
          {error && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">{error}</p>}

          <section className="space-y-2">
            <h3 className="text-lg font-bold text-slate-900">Search the name on the bottle</h3>
            <PillSearchPanel
              compact
              defaultMode="name"
              selectLabel="✓ This one"
              onSelect={(r: SearchResult) =>
                choose({
                  drugName: r.name || `NDC ${r.ndc || r.label}`,
                  label: r.label,
                  ndc: r.ndc ?? undefined,
                  imprint: r.imprint ?? undefined,
                  color: r.color ?? undefined,
                  shape: r.shape ?? undefined,
                })
              }
            />
          </section>
          <button onClick={() => setStep("front")} className="w-full py-3 text-base text-slate-600 underline">
            Retake the photos
          </button>
        </div>
      )}

      {step === "times" && chosen && (
        <div className="space-y-4">
          {header(3, `When do you take ${chosen.drugName}?`)}
          {error && <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-xl p-3">{error}</p>}
          <SchedulePicker drugName={chosen.drugName} initial={null} saveLabel={saving ? "Saving…" : "Save this medicine"} onSave={(p) => save(p)} />
          <label className="flex items-start gap-3 p-3 bg-slate-50 border border-slate-200 rounded-xl">
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} className="mt-1 w-6 h-6 shrink-0" />
            <span className="text-sm text-slate-700">
              <strong>Share this pill&apos;s photo</strong> to help the app recognize {chosen.drugName} for everyone. Only the
              photo and the medicine are shared, never your name or your other medicines.
            </span>
          </label>
          <button
            onClick={() => save(null)}
            disabled={saving}
            className="w-full py-3 bg-slate-100 text-slate-800 font-bold rounded-xl"
          >
            Only as needed (no set times)
          </button>
          <button onClick={() => setStep("name")} className="w-full py-2 text-base text-slate-600 underline">
            Back
          </button>
        </div>
      )}

      {step === "done" && (
        <div className="space-y-4 text-center py-6">
          <p className="text-5xl">✅</p>
          <h2 className="text-2xl font-bold text-slate-900">{added[added.length - 1]} is set up</h2>
          <p className="text-base text-slate-600">
            {added.length === 1 ? "1 medicine" : `${added.length} medicines`} added. Add every medicine you take, so a
            pill check can tell them apart.
          </p>
          <button onClick={reset} className="w-full py-4 bg-indigo-600 text-white text-lg font-bold rounded-2xl">
            + Add another medicine
          </button>
          <button onClick={onFinished} className="w-full py-4 bg-slate-100 text-slate-800 text-lg font-bold rounded-2xl">
            I&apos;m done
          </button>
        </div>
      )}
    </div>
  );
}
