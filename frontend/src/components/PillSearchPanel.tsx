"use client";

import { useState } from "react";
import { searchByName, searchByAppearance, type SearchResult } from "@/lib/api";
import PillThumb from "./PillThumb";
import AddToMedsButton from "./AddToMedsButton";
import { SHAPE_OPTIONS, COLOR_OPTIONS, SCORE_MARK_OPTIONS, SCORE_MARK_LABELS, shapeIconPath, scoreMarkLines } from "@/lib/pillAppearance";

type Mode = "name" | "appearance";

export function ShapeIcon({ shape, size = 28 }: { shape: string; size?: number }) {
  const icon = shapeIconPath(shape);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0">
      {icon.kind === "ellipse" ? (
        (() => {
          const [cx, cy, rx, ry] = icon.d.split(",").map(Number);
          return <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="currentColor" />;
        })()
      ) : icon.kind === "polygon" ? (
        <polygon points={icon.d} fill="currentColor" />
      ) : (
        <path d={icon.d} fill="currentColor" />
      )}
    </svg>
  );
}

export default function PillSearchPanel({
  defaultMode = "name",
  allowNameSearch = true,
  compact = false,
  onSelect,
  selectLabel = "Select",
  addToMeds = false,
  onAdded,
}: {
  defaultMode?: Mode;
  /** Scanner's "don't see your pill?" fallback only offers appearance
      search -- name search belongs to the standalone Lookup tab, not the
      photo-match flow (if you already know the name, you don't need the
      scanner to begin with). */
  allowNameSearch?: boolean;
  compact?: boolean;
  /** When given, each result gets a button that hands it back to the
      caller (e.g. "Save as my pill" in the scanner). */
  onSelect?: (result: SearchResult) => void;
  selectLabel?: string;
  /** Show "+ Add to my medicines" on each result. */
  addToMeds?: boolean;
  onAdded?: () => void;
}) {
  const [mode, setMode] = useState<Mode>(allowNameSearch ? defaultMode : "appearance");
  const [nameQuery, setNameQuery] = useState("");
  const [nameImprint, setNameImprint] = useState("");
  // Multi-select: many pills are two-toned (e.g. red on one half, blue on
  // the other), so a single color choice isn't enough to describe them.
  const [colors, setColors] = useState<string[]>([]);
  const [shape, setShape] = useState<string | null>(null);
  const [imprintSide1, setImprintSide1] = useState("");
  const [imprintSide2, setImprintSide2] = useState("");
  const [scoreMarks, setScoreMarks] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function runNameSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!nameQuery.trim()) return;
    setStatus("loading");
    try {
      setResults(await searchByName(nameQuery.trim(), nameImprint.trim() || undefined));
      setStatus("idle");
    } catch (err: any) {
      setErrorMsg(err?.message || String(err));
      setStatus("error");
    }
  }

  async function runAppearanceSearch(e?: React.FormEvent) {
    e?.preventDefault();
    const imprint = [imprintSide1, imprintSide2].filter((s) => s.trim()).join(" ");
    if (colors.length === 0 && !shape && !imprint && !scoreMarks) return;
    setStatus("loading");
    try {
      setResults(
        await searchByAppearance({
          color: colors.length > 0 ? colors.join(",") : undefined,
          shape: shape ?? undefined,
          imprint: imprint || undefined,
          scoreMarks: scoreMarks ?? undefined,
        })
      );
      setStatus("idle");
    } catch (err: any) {
      setErrorMsg(err?.message || String(err));
      setStatus("error");
    }
  }

  function toggleColor(c: string) {
    setColors((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  function resetAppearance() {
    setColors([]);
    setShape(null);
    setImprintSide1("");
    setImprintSide2("");
    setScoreMarks(null);
    setResults(null);
  }

  return (
    <div className="space-y-4">
      {allowNameSearch && (
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
        <form onSubmit={runNameSearch} className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder="e.g. acetaminophen, Janumet, lisinopril..."
              className="flex-1 min-w-0 px-3 py-2.5 border border-slate-300 rounded-xl text-sm"
            />
            <button type="submit" className="px-4 py-2.5 bg-indigo-600 text-white font-semibold rounded-xl text-sm">
              Search
            </button>
          </div>
          <input
            type="text"
            value={nameImprint}
            onChange={(e) => setNameImprint(e.target.value)}
            placeholder="Letters/numbers on the pill (optional, e.g. L 5)"
            className="w-full px-3 py-2 border border-slate-300 rounded-xl text-sm"
          />
          <p className="text-[11px] text-slate-400">
            Common medicines come in hundreds of versions. Adding the imprint finds the exact one.
          </p>
        </form>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            Fill in whatever you can see — you don't need everything. More detail narrows the results.
          </p>

          {/* Shape -- visual picker */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1.5">Shape</p>
            <div className="flex flex-wrap gap-2">
              {SHAPE_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setShape(shape === s ? null : s)}
                  title={s}
                  className={`flex flex-col items-center gap-0.5 px-2.5 py-2 rounded-xl border text-[9px] font-medium transition ${
                    shape === s
                      ? "bg-indigo-600 border-indigo-600 text-white"
                      : "bg-white border-slate-200 text-slate-600 hover:border-indigo-300"
                  }`}
                >
                  <ShapeIcon shape={s} size={22} />
                  {s.split(" ")[0].toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Color -- swatch picker, multi-select (many pills are two-toned:
              tap both colors you see, e.g. red AND blue for a half-and-half
              capsule). */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1.5">
              Color {colors.length > 1 && <span className="font-normal text-slate-400">(all selected must be present)</span>}
            </p>
            <div className="flex flex-wrap gap-2">
              {COLOR_OPTIONS.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => toggleColor(c.label)}
                  title={c.label}
                  className={`flex flex-col items-center gap-0.5 px-2.5 py-2 rounded-xl border text-[9px] font-medium transition ${
                    colors.includes(c.label)
                      ? "bg-indigo-600 border-indigo-600 text-white"
                      : "bg-white border-slate-200 text-slate-600 hover:border-indigo-300"
                  }`}
                >
                  <span
                    className="w-5 h-5 rounded-full border border-slate-300"
                    style={{ backgroundColor: c.swatch }}
                  />
                  {c.label.toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Score marks -- shown as diagrams of the break-lines on the
              pill, following the standard DailyMed scoring convention
              (1 = whole, 2 = one line, 3 = two lines, 4 = cross-scored). */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1.5">Score marks</p>
            <div className="flex flex-wrap gap-2">
              {SCORE_MARK_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScoreMarks(scoreMarks === s ? null : s)}
                  title={SCORE_MARK_LABELS[s]}
                  className={`flex flex-col items-center gap-0.5 px-2.5 py-2 rounded-xl border text-[9px] font-medium transition ${
                    scoreMarks === s
                      ? "bg-indigo-600 border-indigo-600 text-white"
                      : "bg-white border-slate-200 text-slate-600 hover:border-indigo-300"
                  }`}
                >
                  <svg width={28} height={28} viewBox="0 0 24 24" className="shrink-0">
                    <ellipse cx={12} cy={12} rx={9} ry={9} fill="none" stroke="currentColor" strokeWidth={1.5} />
                    {scoreMarkLines(s).map(([x1, y1, x2, y2], i) => (
                      <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth={1.5} />
                    ))}
                  </svg>
                  <span className="text-center leading-tight">{SCORE_MARK_LABELS[s]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Imprint -- two sides, since many pills have different text on
              each face. These are combined and matched against whichever
              side(s) the reference data actually recorded. */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1.5">Imprint text / numbers</p>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={imprintSide1}
                onChange={(e) => setImprintSide1(e.target.value)}
                placeholder="Side 1 (e.g. 575)"
                className="px-3 py-2 border border-slate-300 rounded-xl text-sm"
              />
              <input
                type="text"
                value={imprintSide2}
                onChange={(e) => setImprintSide2(e.target.value)}
                placeholder="Side 2 (if different)"
                className="px-3 py-2 border border-slate-300 rounded-xl text-sm"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => runAppearanceSearch()}
              className="flex-1 px-4 py-2.5 bg-indigo-600 text-white font-semibold rounded-xl text-sm"
            >
              Search
            </button>
            <button
              onClick={resetAppearance}
              className="px-4 py-2.5 bg-slate-100 text-slate-600 font-semibold rounded-xl text-sm"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {status === "loading" && <p className="text-sm text-slate-400 text-center py-4">Searching...</p>}
      {status === "error" && <p className="text-sm text-red-600 text-center py-4">{errorMsg}</p>}

      {results && results.length === 0 && status === "idle" && (
        <p className="text-sm text-slate-400 text-center py-4">No matches found. Try fewer or broader details.</p>
      )}

      {results && results.length > 0 && (
        <div className={`grid ${compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"} gap-3`}>
          {results.map((r) => (
            <div key={r.label} className="flex gap-3 p-3 min-w-0 bg-white border border-slate-200 rounded-xl shadow-sm">
              <PillThumb
                url={r.reference_image_url}
                kind={r.reference_image_kind}
                alt={r.name || r.label}
                look={{ imprint: r.imprint, color: r.color, shape: r.shape, scoreMarks: r.score_marks }}
              />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-slate-900 text-sm truncate">{r.name || `Name not on file (NDC ${r.ndc || r.label})`}</p>
                <p className="text-[11px] text-slate-400 font-mono truncate">NDC: {r.ndc || "N/A"}</p>
                {r.also_sold_as && r.also_sold_as.length > 0 && (
                  <p className="text-[11px] text-slate-500 truncate" title={r.also_sold_as.join(", ")}>
                    Also sold as: {r.also_sold_as.join(", ")}
                  </p>
                )}
                {(r.imprint || r.color || r.shape) && (
                  <p className="text-[11px] text-slate-500 truncate">
                    {[r.imprint && `Imprint: ${r.imprint}`, r.color, r.shape].filter(Boolean).join(" · ")}
                  </p>
                )}
                {onSelect && (
                  <button
                    type="button"
                    onClick={() => onSelect(r)}
                    className="mt-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg text-xs transition"
                  >
                    {selectLabel}
                  </button>
                )}
                {addToMeds && (
                  <div className="mt-2">
                    <AddToMedsButton drugName={r.name || `NDC ${r.ndc || r.label}`} ndc={r.ndc} onAdded={onAdded} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
