"use client";

import { useEffect, useState } from "react";
import CaptureCropper from "./CaptureCropper";
import { searchByName, ocrLabel, referenceImageSrc, type CatalogMatch } from "@/lib/api";
import {
  addMyPill,
  updateMyPill,
  deleteMyPill,
  getMyPills,
  detectAppearanceChange,
  type MyPillEntry,
  type V3Settings,
} from "@/lib/dbV3";

type AddStep = "closed" | "choose-method" | "by-name" | "by-label-photo" | "attach-photo";

export default function MyPillsTab({ settings }: { settings: V3Settings }) {
  const [entries, setEntries] = useState<MyPillEntry[]>([]);
  const [addStep, setAddStep] = useState<AddStep>("closed");
  const [selectedMatch, setSelectedMatch] = useState<CatalogMatch | null>(null);

  const refresh = () => getMyPills().then(setEntries);
  useEffect(() => {
    refresh();
  }, []);

  const finishAdd = async (personalPhotoDataUrl: string) => {
    if (!selectedMatch) return;
    await addMyPill({
      label: selectedMatch.label,
      ndc: selectedMatch.ndc,
      name: selectedMatch.name,
      officialSnapshot: {
        imprint: selectedMatch.imprint,
        color: selectedMatch.color,
        shape: selectedMatch.shape,
        referenceImageUrl: selectedMatch.reference_image_url,
        fetchedAt: Date.now(),
      },
      personalPhotoDataUrl,
      notes: "",
    });
    setAddStep("closed");
    setSelectedMatch(null);
    refresh();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="rounded-2xl border border-sky-100 bg-sky-50 p-4 text-sm text-sky-900">
        Save a photo of your own pill here. If a refill ever looks different — new shape, color, or imprint — this
        tab will flag exactly what changed so you can ask a pharmacist why.
      </div>

      {entries.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-400">
          No medications saved yet.
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((e) => (
            <MyPillCard key={e.id} entry={e} onChange={refresh} />
          ))}
        </div>
      )}

      <button
        onClick={() => setAddStep("choose-method")}
        className="w-full rounded-xl bg-sky-600 py-3.5 font-bold text-white shadow-sm hover:bg-sky-700"
      >
        + Add a Medication
      </button>

      {addStep !== "closed" && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 sm:rounded-3xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">Add a Medication</h3>
              <button
                onClick={() => {
                  setAddStep("closed");
                  setSelectedMatch(null);
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            {addStep === "choose-method" && (
              <div className="grid grid-cols-1 gap-3">
                <button
                  onClick={() => setAddStep("by-name")}
                  className="rounded-xl bg-slate-100 p-4 text-left hover:bg-slate-200"
                >
                  <p className="font-semibold text-slate-900">Type the medication name</p>
                  <p className="text-xs text-slate-500">e.g. "ibuprofen" or "Advil"</p>
                </button>
                <button
                  onClick={() => setAddStep("by-label-photo")}
                  className="rounded-xl bg-slate-100 p-4 text-left hover:bg-slate-200"
                >
                  <p className="font-semibold text-slate-900">Scan the bottle label</p>
                  <p className="text-xs text-slate-500">Reads the printed label with OCR</p>
                </button>
              </div>
            )}

            {addStep === "by-name" && (
              <NameSearchStep
                onPick={(m) => {
                  setSelectedMatch(m);
                  setAddStep("attach-photo");
                }}
                onBack={() => setAddStep("choose-method")}
              />
            )}

            {addStep === "by-label-photo" && (
              <LabelOcrStep
                onPick={(m) => {
                  setSelectedMatch(m);
                  setAddStep("attach-photo");
                }}
                onBack={() => setAddStep("choose-method")}
              />
            )}

            {addStep === "attach-photo" && selectedMatch && (
              <div>
                <p className="mb-3 text-sm text-slate-600">
                  Optional: add a photo of your own <span className="font-semibold">{selectedMatch.name ?? selectedMatch.label}</span> pill,
                  so you can compare it later.
                </p>
                <CaptureCropper
                  title="Photograph your pill"
                  helpText="Pinch or use +/- to zoom, drag to center, then tap Use This Photo."
                  initialBrightness={settings.brightness}
                  onCapture={(canvas) => finishAdd(canvas.toDataURL("image/jpeg", 0.92))}
                />
                <button
                  onClick={() => finishAdd("")}
                  className="mt-3 w-full text-sm font-semibold text-slate-400 hover:text-slate-600"
                >
                  Skip photo, just save the name
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NameSearchStep({ onPick, onBack }: { onPick: (m: CatalogMatch) => void; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogMatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setResults(await searchByName(query, 15));
    } catch (e: any) {
      setError(e?.message || "Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder="Medication name"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          onClick={runSearch}
          disabled={loading}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? "…" : "Search"}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <MatchList results={results} onPick={onPick} />
      <button onClick={onBack} className="text-sm font-medium text-slate-400 hover:text-slate-600">
        ← Back
      </button>
    </div>
  );
}

function LabelOcrStep({ onPick, onBack }: { onPick: (m: CatalogMatch) => void; onBack: () => void }) {
  const [results, setResults] = useState<CatalogMatch[] | null>(null);
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captured, setCaptured] = useState(false);

  const handleCapture = async (canvas: HTMLCanvasElement) => {
    setCaptured(true);
    setLoading(true);
    setError(null);
    canvas.toBlob(async (blob) => {
      if (!blob) {
        setError("Could not process that photo.");
        setLoading(false);
        return;
      }
      try {
        const file = new File([blob], "label.jpg", { type: "image/jpeg" });
        const { raw_text, candidates } = await ocrLabel(file);
        setRawText(raw_text);
        setResults(candidates);
      } catch (e: any) {
        setError(e?.message || "OCR failed. Try typing the name instead.");
      } finally {
        setLoading(false);
      }
    }, "image/jpeg", 0.92);
  };

  if (!captured) {
    return (
      <div>
        <CaptureCropper
          title="Photograph the bottle label"
          helpText="Frame the printed drug name so it's readable."
          onCapture={handleCapture}
        />
        <button onClick={onBack} className="mt-3 text-sm font-medium text-slate-400 hover:text-slate-600">
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {loading && <p className="text-sm text-slate-500">Reading label…</p>}
      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {rawText && (
        <details className="rounded-lg bg-slate-50 p-2 text-xs text-slate-500">
          <summary className="cursor-pointer font-medium">Raw text read from label</summary>
          <pre className="mt-1 whitespace-pre-wrap">{rawText}</pre>
        </details>
      )}
      <MatchList results={results} onPick={onPick} />
      <button
        onClick={() => {
          setCaptured(false);
          setResults(null);
          setError(null);
        }}
        className="text-sm font-medium text-slate-400 hover:text-slate-600"
      >
        ← Retake photo
      </button>
    </div>
  );
}

function MatchList({ results, onPick }: { results: CatalogMatch[] | null; onPick: (m: CatalogMatch) => void }) {
  if (results === null) return null;
  if (results.length === 0) return <p className="text-sm text-slate-400">No matches. Try a different search.</p>;
  return (
    <div className="max-h-64 space-y-2 overflow-y-auto">
      {results.map((m) => (
        <button
          key={m.label}
          onClick={() => onPick(m)}
          className="flex w-full items-center gap-3 rounded-lg border border-slate-200 p-2.5 text-left hover:border-sky-400 hover:bg-sky-50"
        >
          {m.reference_image_url ? (
            <img
              src={referenceImageSrc(m.reference_image_url)}
              alt={m.name ?? m.label}
              className="h-11 w-11 rounded-lg border border-slate-200 object-contain bg-slate-50"
            />
          ) : (
            <div className="h-11 w-11 rounded-lg bg-slate-100" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold capitalize text-slate-800">{m.name ?? `NDC ${m.ndc}`}</p>
            <p className="text-[11px] text-slate-400">{[m.color, m.shape, m.imprint].filter(Boolean).join(" · ")}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

function MyPillCard({ entry, onChange }: { entry: MyPillEntry; onChange: () => void }) {
  const [current, setCurrent] = useState<CatalogMatch | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const checkForChanges = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const query = entry.ndc || entry.name || entry.label;
      const matches = await searchByName(query, 10);
      const found = matches.find((m) => m.label === entry.label) ?? matches[0] ?? null;
      setCurrent(found);
    } catch (e: any) {
      setCheckError(e?.message || "Couldn't check right now. Please try again.");
    } finally {
      setChecking(false);
    }
  };

  const changes = current
    ? detectAppearanceChange(entry.officialSnapshot, {
        imprint: current.imprint,
        color: current.color,
        shape: current.shape,
      })
    : [];

  const flagToPharmacist = async () => {
    const msg = `Hi — I have a prescription refill for ${entry.name ?? entry.label} (NDC ${entry.ndc ?? "unknown"}) that looks different from what I was previously given. ${changes.join("; ")}. Can you confirm this is correct?`;
    try {
      await navigator.clipboard.writeText(msg);
      alert("Message copied — paste it to your pharmacist.");
    } catch {
      alert(msg);
    }
    await updateMyPill({ ...entry, changeAcknowledged: true });
    onChange();
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-3">
          <div className="text-center">
            <p className="mb-1 text-[10px] font-semibold uppercase text-slate-400">Yours</p>
            {entry.personalPhotoDataUrl ? (
              <img src={entry.personalPhotoDataUrl} className="h-16 w-16 rounded-lg border border-slate-200 object-cover" />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-slate-100 text-[10px] text-slate-400">
                No photo
              </div>
            )}
          </div>
          <div className="text-center">
            <p className="mb-1 text-[10px] font-semibold uppercase text-slate-400">Currently on file</p>
            {(current?.reference_image_url ?? entry.officialSnapshot.referenceImageUrl) ? (
              <img
                src={referenceImageSrc(current?.reference_image_url ?? entry.officialSnapshot.referenceImageUrl)}
                className="h-16 w-16 rounded-lg border border-indigo-200 bg-white object-contain p-0.5"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-indigo-50 text-[10px] text-indigo-300">
                No image
              </div>
            )}
          </div>
        </div>
        <button onClick={() => deleteMyPill(entry.id).then(onChange)} className="text-xs text-slate-300 hover:text-red-500">
          Remove
        </button>
      </div>

      <p className="mt-2 font-semibold capitalize text-slate-900">{entry.name ?? entry.label}</p>
      <p className="text-xs text-slate-400">NDC {entry.ndc ?? "N/A"} · saved {new Date(entry.savedAt).toLocaleDateString()}</p>

      {changes.length > 0 && (
        <div className="mt-3 rounded-xl border-l-4 border-amber-400 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">⚠ This looks different than when you saved it</p>
          <ul className="mt-1 list-inside list-disc text-xs text-amber-800">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button
            onClick={flagToPharmacist}
            className="mt-2 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-600"
          >
            Copy a message for my pharmacist
          </button>
        </div>
      )}

      <button
        onClick={checkForChanges}
        disabled={checking}
        className="mt-3 text-xs font-semibold text-sky-600 hover:text-sky-700 disabled:opacity-50"
      >
        {checking ? "Checking…" : "Check what's currently on file"}
      </button>
      {checkError && <p className="mt-1 text-xs text-red-600">{checkError}</p>}
    </div>
  );
}
