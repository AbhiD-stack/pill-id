"use client";

import { useCallback, useState } from "react";
import {
  predictPill,
  referenceImageSrc,
  type PredictionResult,
} from "@/lib/api";

export function PillIdentifier() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [results, setResults] = useState<PredictionResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const selectFile = useCallback(
    (f: File | null) => {
      setError(null);
      setResults(null);
      setFile(f);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(f ? URL.createObjectURL(f) : null);
    },
    [previewUrl]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files?.[0];
      if (f && f.type.startsWith("image/")) selectFile(f);
      else if (f) setError("Please drop an image file (JPG or PNG).");
    },
    [selectFile]
  );

  const onIdentify = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const res = await predictPill(file);
      setResults(res.predictions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }, [file]);

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      {/* ── Left: upload ───────────────────────────────────────────── */}
      <section className="lg:col-span-2">
        <div className="lg:sticky lg:top-6">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">
            1 · Upload a pill photo
          </h2>

          {/* <label> so clicking natively opens the picker (no JS click
              bubbling, which previously double-fired and dropped the file). */}
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex aspect-square cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed p-4 text-center transition-colors ${
              dragging
                ? "border-sky-400 bg-sky-50"
                : "border-slate-300 bg-white hover:border-sky-300 hover:bg-slate-50"
            }`}
          >
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => selectFile(e.target.files?.[0] ?? null)}
            />
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="Selected pill"
                className="max-h-full max-w-full rounded-xl object-contain"
              />
            ) : (
              <>
                <svg
                  className="mb-3 h-10 w-10 text-slate-300"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
                  />
                </svg>
                <p className="text-sm font-medium text-slate-700">
                  Click to upload or drag &amp; drop
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  JPG or PNG, up to 15 MB
                </p>
              </>
            )}
          </label>

          {file && (
            <p className="mt-2 truncate text-center text-xs text-slate-500">
              {file.name}
            </p>
          )}

          <button
            onClick={onIdentify}
            disabled={!file || loading}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
          >
            {loading && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            )}
            {loading ? "Identifying…" : "Identify pill"}
          </button>

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      </section>

      {/* ── Right: results pyramid ─────────────────────────────────── */}
      <section className="lg:col-span-3">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">
          2 · Top matches{" "}
          <span className="font-normal text-slate-400">
            (suggestions only — verify independently)
          </span>
        </h2>
        {loading ? (
          <LoadingState />
        ) : results ? (
          <ResultsPyramid results={results} />
        ) : (
          <EmptyState />
        )}
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white/50 p-8 text-center">
      <svg
        className="mb-3 h-10 w-10 text-slate-300"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
        />
      </svg>
      <p className="text-sm font-medium text-slate-500">
        Your top 5 matches will appear here
      </p>
      <p className="mt-1 text-xs text-slate-400">
        Upload a photo and click “Identify pill”.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3">
      <div className="h-40 animate-pulse rounded-2xl bg-slate-100" />
      <div className="grid grid-cols-2 gap-3">
        <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
        <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="h-20 animate-pulse rounded-2xl bg-slate-100" />
        <div className="h-20 animate-pulse rounded-2xl bg-slate-100" />
      </div>
    </div>
  );
}

function ResultsPyramid({ results }: { results: PredictionResult[] }) {
  if (results.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
        No matches found.
      </div>
    );
  }

  const [first, ...rest] = results;
  const row2 = rest.slice(0, 2); // ranks 2–3
  const row3 = rest.slice(2, 4); // ranks 4–5

  return (
    <div className="space-y-3">
      <ResultCard r={first} rank={1} size="lg" />

      {row2.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {row2.map((r, i) => (
            <ResultCard key={`${r.label}-${i}`} r={r} rank={i + 2} size="md" />
          ))}
        </div>
      )}

      {row3.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {row3.map((r, i) => (
            <ResultCard key={`${r.label}-${i}`} r={r} rank={i + 4} size="sm" />
          ))}
        </div>
      )}

      <p className="pt-1 text-xs text-slate-400">
        Match score reflects visual similarity to reference images, not a
        confirmed identification.
      </p>
    </div>
  );
}

type CardSize = "lg" | "md" | "sm";

function ResultCard({
  r,
  rank,
  size,
}: {
  r: PredictionResult;
  rank: number;
  size: CardSize;
}) {
  const imgSize =
    size === "lg" ? "h-24 w-24" : size === "md" ? "h-16 w-16" : "h-12 w-12";
  const nameSize = size === "lg" ? "text-base" : "text-sm";
  const showDetails = size !== "sm"; // imprint/color on lg + md
  const isTop = size === "lg";

  return (
    <div
      className={`flex gap-3 rounded-2xl border bg-white p-3 ${
        isTop
          ? "border-sky-200 shadow-sm ring-1 ring-sky-100"
          : "border-slate-200"
      }`}
    >
      <div className="relative shrink-0">
        {r.reference_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={referenceImageSrc(r.reference_image_url)}
            alt={`Reference image for ${r.name ?? r.ndc}`}
            className={`${imgSize} rounded-xl border border-slate-200 object-contain`}
          />
        ) : (
          <div
            className={`${imgSize} flex items-center justify-center rounded-xl border border-dashed border-slate-200 text-[10px] text-slate-400`}
          >
            no image
          </div>
        )}
        <span
          className={`absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white ${
            isTop ? "bg-sky-600" : "bg-slate-400"
          }`}
        >
          {rank}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        {isTop && (
          <span className="mb-0.5 inline-block rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">
            Top match
          </span>
        )}

        {r.name ? (
          <>
            <p
              className={`truncate font-semibold capitalize text-slate-800 ${nameSize}`}
            >
              {r.name}
            </p>
            <p className="font-mono text-xs text-slate-400">NDC {r.ndc}</p>
          </>
        ) : (
          <>
            <p className={`truncate font-mono font-semibold text-slate-800 ${nameSize}`}>
              {r.ndc}
            </p>
            <p className="text-xs text-slate-400">name unavailable</p>
          </>
        )}

        {showDetails && (r.imprint || r.color) && (
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {r.imprint && (
              <span>
                Imprint{" "}
                <span className="font-medium text-slate-700">{r.imprint}</span>
              </span>
            )}
            {r.imprint && r.color && " · "}
            {r.color && <span className="capitalize">{r.color}</span>}
          </p>
        )}

        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${
                isTop ? "bg-sky-600" : "bg-sky-400"
              }`}
              style={{ width: `${Math.min(100, r.score_pct)}%` }}
            />
          </div>
          <span className="w-11 shrink-0 text-right text-xs font-semibold text-slate-600">
            {r.score_pct}%
          </span>
        </div>
      </div>
    </div>
  );
}
