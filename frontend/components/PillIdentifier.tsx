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

  const selectFile = useCallback((f: File | null) => {
    setError(null);
    setResults(null);
    setFile(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
  }, [previewUrl]);

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
    <div className="space-y-6">
      {/* Upload area — a <label> so clicking natively opens the picker (no JS
          click bubbling, which previously double-fired and dropped the file). */}
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging
            ? "border-sky-400 bg-sky-50"
            : "border-slate-300 bg-white hover:border-sky-300"
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
            className="max-h-56 rounded-lg object-contain"
          />
        ) : (
          <>
            <p className="text-sm font-medium text-slate-700">
              Click to upload or drag &amp; drop a pill photo
            </p>
            <p className="mt-1 text-xs text-slate-400">JPG or PNG, up to 15 MB</p>
          </>
        )}
      </label>

      {file && (
        <p className="truncate text-center text-xs text-slate-500">{file.name}</p>
      )}

      <button
        onClick={onIdentify}
        disabled={!file || loading}
        className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {loading ? "Identifying…" : "Identify pill"}
      </button>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {results && <ResultsList results={results} />}
    </div>
  );
}

function ResultsList({ results }: { results: PredictionResult[] }) {
  if (results.length === 0) {
    return (
      <p className="text-center text-sm text-slate-500">No matches found.</p>
    );
  }
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-700">
        Top matches{" "}
        <span className="font-normal text-slate-400">
          (suggestions only — verify independently)
        </span>
      </h2>
      <ul className="space-y-2">
        {results.map((r, i) => (
          <li
            key={`${r.label}-${i}`}
            className="flex items-center gap-4 rounded-lg border border-slate-200 bg-white p-3"
          >
            <span className="w-5 shrink-0 text-center text-sm font-semibold text-slate-400">
              {i + 1}
            </span>
            {r.reference_image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={referenceImageSrc(r.reference_image_url)}
                alt={`Reference image for ${r.label}`}
                className="h-16 w-16 shrink-0 rounded-md border border-slate-200 object-contain"
              />
            ) : (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-200 text-[10px] text-slate-400">
                no image
              </div>
            )}
            <div className="min-w-0 flex-1">
              {r.name ? (
                <>
                  <p className="truncate text-sm font-semibold capitalize text-slate-800">
                    {r.name}
                  </p>
                  <p className="font-mono text-xs text-slate-400">
                    NDC {r.ndc}
                    {r.status && r.status !== "ACTIVE" && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                        {r.status.toLowerCase()}
                      </span>
                    )}
                  </p>
                </>
              ) : (
                <>
                  <p className="truncate font-mono text-sm font-semibold text-slate-800">
                    {r.ndc}
                  </p>
                  <p className="text-xs text-slate-400">
                    NDC code (name unavailable)
                  </p>
                </>
              )}
              {(r.imprint || r.color) && (
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {r.imprint && (
                    <span>
                      Imprint{" "}
                      <span className="font-medium text-slate-700">
                        {r.imprint}
                      </span>
                    </span>
                  )}
                  {r.imprint && r.color && " · "}
                  {r.color && <span className="capitalize">{r.color}</span>}
                </p>
              )}
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-sky-500"
                    style={{ width: `${Math.min(100, r.score_pct)}%` }}
                  />
                </div>
                <span className="w-12 shrink-0 text-right text-xs font-medium text-slate-500">
                  {r.score_pct}%
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-400">
        Match score reflects visual similarity to reference images, not a
        confirmed identification.
      </p>
    </div>
  );
}
