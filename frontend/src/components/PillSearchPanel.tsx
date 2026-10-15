"use client";

import { useState } from "react";
import { searchByName, searchByAppearance, type SearchResult } from "@/lib/api";

type Mode = "name" | "appearance";

export default function PillSearchPanel({
  defaultMode = "name",
  showModeToggle = true,
  compact = false,
}: {
  defaultMode?: Mode;
  showModeToggle?: boolean;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [nameQuery, setNameQuery] = useState("");
  const [color, setColor] = useState("");
  const [shape, setShape] = useState("");
  const [imprint, setImprint] = useState("");
  const [scoreMarks, setScoreMarks] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function runNameSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!nameQuery.trim()) return;
    setStatus("loading");
    try {
      setResults(await searchByName(nameQuery.trim()));
      setStatus("idle");
    } catch (err: any) {
      setErrorMsg(err?.message || String(err));
      setStatus("error");
    }
  }

  async function runAppearanceSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!color && !shape && !imprint && !scoreMarks) return;
    setStatus("loading");
    try {
      setResults(await searchByAppearance({ color, shape, imprint, scoreMarks }));
      setStatus("idle");
    } catch (err: any) {
      setErrorMsg(err?.message || String(err));
      setStatus("error");
    }
  }

  return (
    <div className="space-y-4">
      {showModeToggle && (
        <div className="flex gap-2">
          <button
            onClick={() => { setMode("name"); setResults(null); }}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold transition ${
              mode === "name" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"
            }`}
          >
            Search by name
          </button>
          <button
            onClick={() => { setMode("appearance"); setResults(null); }}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold transition ${
              mode === "appearance" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"
            }`}
          >
            Describe appearance
          </button>
        </div>
      )}

      {mode === "name" ? (
        <form onSubmit={runNameSearch} className="flex gap-2">
          <input
            type="text"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder="e.g. acetaminophen, Janumet, lisinopril..."
            className="flex-1 px-3 py-2.5 border border-slate-300 rounded-xl text-sm"
          />
          <button type="submit" className="px-4 py-2.5 bg-indigo-600 text-white font-semibold rounded-xl text-sm">
            Search
          </button>
        </form>
      ) : (
        <form onSubmit={runAppearanceSearch} className="space-y-2">
          <p className="text-xs text-slate-500">
            Fill in whatever you can see — you don't need all four. More detail narrows the results.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="Color (e.g. white, pink)"
              className="px-3 py-2 border border-slate-300 rounded-xl text-sm"
            />
            <input
              type="text"
              value={shape}
              onChange={(e) => setShape(e.target.value)}
              placeholder="Shape (e.g. round, oval)"
              className="px-3 py-2 border border-slate-300 rounded-xl text-sm"
            />
            <input
              type="text"
              value={imprint}
              onChange={(e) => setImprint(e.target.value)}
              placeholder="Imprint text/numbers"
              className="px-3 py-2 border border-slate-300 rounded-xl text-sm"
            />
            <input
              type="text"
              value={scoreMarks}
              onChange={(e) => setScoreMarks(e.target.value)}
              placeholder="Score marks (e.g. 1, 2)"
              className="px-3 py-2 border border-slate-300 rounded-xl text-sm"
            />
          </div>
          <button type="submit" className="w-full px-4 py-2.5 bg-indigo-600 text-white font-semibold rounded-xl text-sm">
            Search
          </button>
        </form>
      )}

      {status === "loading" && <p className="text-sm text-slate-400 text-center py-4">Searching...</p>}
      {status === "error" && <p className="text-sm text-red-600 text-center py-4">{errorMsg}</p>}

      {results && results.length === 0 && status === "idle" && (
        <p className="text-sm text-slate-400 text-center py-4">No matches found. Try fewer or broader details.</p>
      )}

      {results && results.length > 0 && (
        <div className={`grid ${compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"} gap-3`}>
          {results.map((r) => (
            <div key={r.label} className="flex gap-3 p-3 bg-white border border-slate-200 rounded-xl shadow-sm">
              {r.reference_image_url ? (
                <img
                  src={r.reference_image_url}
                  alt={r.name || r.label}
                  className="w-16 h-16 rounded-lg border border-slate-200 object-contain bg-slate-50 p-1 shrink-0"
                />
              ) : (
                <div className="w-16 h-16 rounded-lg border border-slate-200 bg-slate-50 shrink-0 flex items-center justify-center text-slate-300 text-xs">
                  No image
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-bold text-slate-900 text-sm truncate">{r.name || r.label}</p>
                <p className="text-[11px] text-slate-400 font-mono">NDC: {r.ndc || "N/A"}</p>
                {(r.imprint || r.color || r.shape) && (
                  <p className="text-[11px] text-slate-500 truncate">
                    {[r.imprint && `Imprint: ${r.imprint}`, r.color, r.shape].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
