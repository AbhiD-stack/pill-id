"use client";

import { useState } from "react";
import CaptureCropper from "./CaptureCropper";
import {
  predictPill,
  referenceImageSrc,
  fetchSecureImageBlob,
  searchByAttributes,
  type PredictionResult,
  type CatalogMatch,
  type AttributeFilters,
} from "@/lib/api";
import { addMyPill, type V3Settings } from "@/lib/dbV3";
import { addLogEntry, addScheduleEntry, checkCompliance, getRecentDrugNames, type TimeOfDay } from "@/lib/db";
import { fullSafetyCheck, type BeersFlag, type InteractionFlag } from "@/lib/safety";
import { vibrate } from "@/components/AudioAlert";
import type { MasterTokenApi } from "@/lib/masterToken";
import { FilterDropdown, COLOR_OPTIONS, SHAPE_OPTIONS, SCORE_OPTIONS } from "./FilterDropdown";
import { DisclaimerBanner } from "@/components/Disclaimer";
import { useDragToSchedule, ScheduleDropZones, DragGhost, type DragHandleProps } from "./DragToSchedule";

type Stage = "capture" | "loading" | "results";

export default function ScanTab({ settings, masterToken }: { settings: V3Settings; masterToken: MasterTokenApi }) {
  const [stage, setStage] = useState<Stage>("capture");
  const [results, setResults] = useState<PredictionResult[]>([]);
  const [scannedPhoto, setScannedPhoto] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [savedLabels, setSavedLabels] = useState<Set<string>>(new Set());
  const [scheduledLabels, setScheduledLabels] = useState<Record<string, TimeOfDay>>({});
  const [safety, setSafety] = useState<{ beers: BeersFlag | null; interactions: InteractionFlag[] } | null>(null);

  const handleCapture = async (canvas: HTMLCanvasElement, meta: { rotation: number; adjustments: number }) => {
    setStage("loading");
    setError(null);
    setSafety(null);
    setScannedPhoto(canvas.toDataURL("image/jpeg", 0.92));
    const t0 = performance.now();

    canvas.toBlob(async (blob) => {
      if (!blob) {
        setError("Could not process that photo. Please try again.");
        setStage("capture");
        return;
      }
      const file = new File([blob], "scan.jpg", { type: "image/jpeg" });
      try {
        const { predictions } = await predictPill(file);
        const latencyMs = performance.now() - t0;
        const withImages = await Promise.all(
          predictions.map(async (p) => ({
            ...p,
            reference_image_url: p.reference_image_url
              ? await fetchSecureImageBlob(referenceImageSrc(p.reference_image_url))
              : null,
          }))
        );
        const top = withImages.slice(0, settings.resultCount);
        setResults(top);
        setStage("results");

        masterToken.addIdentification(
          top.map((p) => p.name?.trim() || p.ndc || p.label),
          top.map((p) => p.score),
          meta.rotation,
          meta.adjustments,
          latencyMs
        );

        const topMatch = top[0];
        if (topMatch) {
          vibrate([100, 50, 100]);
          const drugName = topMatch.name?.trim() || topMatch.label;
          const existing = await getRecentDrugNames(24 * 30);
          setSafety(await fullSafetyCheck(drugName, existing));
        }
      } catch (e) {
        console.error(e);
        setError("Couldn't identify that photo. Try better lighting or a tighter crop.");
        setStage("capture");
      }
    }, "image/jpeg", 0.92);
  };

  const handleSaveToMyPills = async (r: PredictionResult) => {
    await addMyPill({
      label: r.label,
      ndc: r.ndc,
      name: r.name,
      officialSnapshot: {
        imprint: r.imprint,
        color: r.color,
        shape: r.shape,
        referenceImageUrl: r.reference_image_url,
        fetchedAt: Date.now(),
      },
      personalPhotoDataUrl: scannedPhoto,
      notes: "",
    });
    setSavedLabels((prev) => new Set(prev).add(r.label));
  };

  const handleAddToSchedule = async (r: PredictionResult, bucket: TimeOfDay) => {
    const drugName = r.name?.trim() || r.label;
    await addScheduleEntry({ drugName, ndc: r.ndc ?? undefined, bucket });
    const now = new Date();
    await addLogEntry({
      drugName,
      ndc: r.ndc ?? undefined,
      scannedAt: now.getTime(),
      bucket,
      onSchedule: checkCompliance(now, bucket),
    });
    setScheduledLabels((prev) => ({ ...prev, [r.label]: bucket }));
    vibrate(250);
  };

  const reset = () => {
    setResults([]);
    setScannedPhoto("");
    setError(null);
    setSavedLabels(new Set());
    setScheduledLabels({});
    setSafety(null);
    setStage("capture");
  };

  const { zoneRefs, activeZone, drag, bindDragHandle } = useDragToSchedule<PredictionResult>((r, bucket) => {
    handleAddToSchedule(r, bucket);
  });

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <DragGhost drag={drag} />
      <DisclaimerBanner />

      {stage === "capture" && (
        <div>
          <CaptureCropper
            onCapture={handleCapture}
            title="Scan a pill"
            helpText="Photograph the side with the printed imprint (letters/numbers) facing the camera — that's what's matched against. No imprint on either side? Either side is fine. Crop tightly to exclude background, rotate if needed, then tap Use This Photo."
            initialBrightness={settings.brightness}
          />
          {error && (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}
        </div>
      )}

      {stage === "loading" && (
        <div className="py-16 text-center">
          <div className="mb-3 animate-pulse text-4xl">🔍</div>
          <p className="font-medium text-slate-700">Analyzing photo…</p>
        </div>
      )}

      {stage === "results" && (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-900">
              {results.length > 0 ? `Top ${results.length} matches` : "No matches found"}
            </h2>
            <button onClick={reset} className="text-sm font-semibold text-sky-600 hover:text-sky-700">
              Scan Another
            </button>
          </div>

          {scannedPhoto && results.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="mb-2 text-center text-xs font-bold uppercase tracking-wide text-slate-400">
                Compare your photo to the best match
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center">
                  <p className="mb-1.5 text-[11px] font-semibold text-slate-500">Your Photo</p>
                  <img
                    src={scannedPhoto}
                    alt="Your scan"
                    className="mx-auto h-28 w-28 rounded-xl border border-slate-300 bg-slate-50 object-contain"
                  />
                </div>
                <div className="text-center">
                  <p className="mb-1.5 text-[11px] font-semibold text-indigo-600">Top Match Reference</p>
                  {results[0].reference_image_url ? (
                    <img
                      src={results[0].reference_image_url}
                      alt={results[0].name ?? results[0].label}
                      className="mx-auto h-28 w-28 rounded-xl border border-indigo-200 bg-white object-contain p-1"
                    />
                  ) : (
                    <div className="mx-auto flex h-28 w-28 items-center justify-center rounded-xl bg-indigo-50 text-indigo-300">
                      No image
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {safety && (safety.beers || safety.interactions.length > 0) && (
            <div className="rounded-xl border-l-4 border-red-500 bg-red-50 p-3">
              {safety.beers && (
                <p className="text-sm font-medium text-red-900">
                  ⚠ Beers Criteria ({safety.beers.risk_level}): {safety.beers.rationale} {safety.beers.recommendation}
                </p>
              )}
              {safety.interactions.map((i, idx) => (
                <p key={idx} className="text-sm font-medium text-red-900">
                  ⚠ Interaction ({i.severity}): {i.description}
                </p>
              ))}
              <p className="mt-1 text-[11px] text-red-500">
                Based on the top match vs. your Care tab schedule — not a substitute for pharmacist review.
              </p>
            </div>
          )}

          <ScheduleDropZones zoneRefs={zoneRefs} activeZone={activeZone} />

          <div className="space-y-3">
            {results.map((r, i) => (
              <ResultCard
                key={r.label}
                result={r}
                rank={i + 1}
                saved={savedLabels.has(r.label)}
                onSave={() => handleSaveToMyPills(r)}
                onSchedule={(bucket) => handleAddToSchedule(r, bucket)}
                scheduledBucket={scheduledLabels[r.label] ?? null}
                dragHandleProps={bindDragHandle(r.name?.trim() || `NDC ${r.ndc ?? "unknown"}`, r)}
              />
            ))}
          </div>

          <AppearanceFilterFallback />
        </div>
      )}
    </div>
  );
}

function ResultCard({
  result,
  rank,
  saved,
  onSave,
  onSchedule,
  scheduledBucket,
  dragHandleProps,
}: {
  result: PredictionResult;
  rank: number;
  saved: boolean;
  onSave: () => void;
  onSchedule: (bucket: TimeOfDay) => void;
  scheduledBucket: TimeOfDay | null;
  dragHandleProps: DragHandleProps;
}) {
  const displayName = result.name?.trim() || `NDC ${result.ndc ?? "unknown"}`;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex gap-3">
        <div className="relative shrink-0">
          {rank === 1 && (
            <span className="absolute -left-1.5 -top-1.5 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
              Best
            </span>
          )}
          {result.reference_image_url ? (
            <img
              src={result.reference_image_url}
              alt={displayName}
              className="h-16 w-16 rounded-xl border border-slate-200 object-contain bg-slate-50 p-1"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-slate-100 text-slate-300">?</div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold capitalize text-slate-900">{displayName}</p>
          <p className="font-mono text-[11px] text-slate-400">NDC {result.ndc ?? "N/A"}</p>
          <p className="text-xs text-slate-500">
            {[result.imprint && `Imprint: ${result.imprint}`, result.color && `Color: ${result.color}`, result.shape && `Shape: ${result.shape}`]
              .filter(Boolean)
              .join(" · ") || "No appearance data on file"}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-sky-600" style={{ width: `${result.score_pct}%` }} />
            </div>
            <span className="w-9 shrink-0 text-right text-[11px] font-semibold text-slate-500">{result.score_pct}%</span>
          </div>
        </div>
        <button
          onClick={onSave}
          disabled={saved}
          className={`h-fit shrink-0 self-center rounded-lg px-3 py-2 text-xs font-bold transition ${
            saved ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
          }`}
        >
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>

      {scheduledBucket ? (
        <div className="mt-2.5 flex items-center justify-center gap-1.5 rounded-xl border-t border-slate-100 bg-emerald-50 py-2 text-sm font-semibold text-emerald-700">
          ✓ Scheduled for {scheduledBucket}
        </div>
      ) : (
        <div
          {...dragHandleProps}
          className="mt-2.5 flex min-h-tap touch-none cursor-grab select-none items-center justify-center gap-2 rounded-xl border-2 border-dashed border-sky-300 bg-sky-50 text-sm font-bold text-sky-700 active:cursor-grabbing active:bg-sky-100"
        >
          <span aria-hidden="true">⠿⠿</span> Hold and drag to a time of day
        </div>
      )}

      <div className="mt-2 flex items-center justify-center gap-1.5 pt-1">
        <span className="text-[11px] font-medium text-slate-400">or tap:</span>
        {(["morning", "noon", "night"] as TimeOfDay[]).map((bucket) => (
          <button
            key={bucket}
            onClick={() => onSchedule(bucket)}
            className={`rounded-md px-2 py-1 text-[11px] font-semibold capitalize transition ${
              scheduledBucket === bucket ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {bucket === "morning" ? "🌅" : bucket === "noon" ? "☀️" : "🌙"} {bucket}
          </button>
        ))}
      </div>
    </div>
  );
}

// Epocrates-style backup search: only meant to be used when the photo scan
// above didn't surface the right pill. Collapsed by default so it doesn't
// compete with the primary scan-and-match flow.
function AppearanceFilterFallback() {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<AttributeFilters>({});
  const [matches, setMatches] = useState<CatalogMatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const runSearch = async () => {
    setLoading(true);
    setSearchError(null);
    try {
      setMatches(await searchByAttributes(filters, 15));
    } catch (e: any) {
      setSearchError(e?.message || "Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left text-sm font-semibold text-slate-700"
      >
        <span>Not the right pill? Search by appearance instead</span>
        <span className="text-slate-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-slate-500">
            Describe what the pill looks like — this is a backup for when a photo doesn't match, like a pharmacist
            identifier guide. Pick the closest option; you don't need every field filled in.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <FilterDropdown
              label="Color"
              placeholder="Any color"
              value={filters.color ?? ""}
              onChange={(v) => setFilters((f) => ({ ...f, color: v }))}
              options={COLOR_OPTIONS}
            />
            <FilterDropdown
              label="Shape"
              placeholder="Any shape"
              value={filters.shape ?? ""}
              onChange={(v) => setFilters((f) => ({ ...f, shape: v }))}
              options={SHAPE_OPTIONS}
            />
            <input
              placeholder="Imprint (e.g. L484)"
              value={filters.imprint ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, imprint: e.target.value }))}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <FilterDropdown
              label="Score marks"
              placeholder="Any score marks"
              value={filters.score ?? ""}
              onChange={(v) => setFilters((f) => ({ ...f, score: v }))}
              options={SCORE_OPTIONS}
            />
          </div>
          <p className="text-[11px] text-slate-400">
            Shape and score-mark data is still being added to the reference database — those two filters may not
            find matches yet even for common pills. Color and imprint are more complete.
          </p>
          <button
            onClick={runSearch}
            disabled={loading}
            className="w-full rounded-lg bg-slate-800 py-2.5 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
          >
            {loading ? "Searching…" : "Search"}
          </button>

          {searchError && <p className="text-xs text-red-600">{searchError}</p>}

          {matches && (
            <div className="space-y-2 pt-1">
              {matches.length === 0 && <p className="text-xs text-slate-400">No matches for those filters.</p>}
              {matches.map((m) => (
                <div key={m.label} className="flex items-center gap-3 rounded-lg bg-white p-2.5 shadow-sm">
                  {m.reference_image_url ? (
                    <img
                      src={referenceImageSrc(m.reference_image_url)}
                      alt={m.name ?? m.label}
                      className="h-12 w-12 rounded-lg border border-slate-200 object-contain bg-slate-50"
                    />
                  ) : (
                    <div className="h-12 w-12 rounded-lg bg-slate-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold capitalize text-slate-800">{m.name ?? `NDC ${m.ndc}`}</p>
                    <p className="text-[11px] text-slate-400">
                      {[m.color, m.shape, m.imprint].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
