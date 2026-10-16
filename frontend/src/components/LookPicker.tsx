"use client";

import { COLOR_OPTIONS, SHAPE_OPTIONS } from "@/lib/pillAppearance";
import type { PillLook } from "@/lib/api";
import { ShapeIcon } from "./PillSearchPanel";

const MAIN_SHAPES = ["ROUND", "OVAL", "CAPSULE"];
const swatch = (c: string) => COLOR_OPTIONS.find((o) => o.label === c)?.swatch ?? "#e2e8f0";
const nice = (w: string) => w.charAt(0) + w.slice(1).toLowerCase();

// "What color and shape is it?" -- big tap targets, up to two colors (two-
// tone capsules) and one shape. The camera's guess is offered, never
// pre-selected: it's only used once the user says it matches.
export default function LookPicker({
  value,
  onChange,
  suggestion,
  reading,
}: {
  value: PillLook;
  onChange: (look: PillLook) => void;
  suggestion: PillLook | null;
  reading: boolean;
}) {
  const toggleColor = (c: string) => {
    const on = value.colors.includes(c);
    const colors = on ? value.colors.filter((x) => x !== c) : [...value.colors, c].slice(-2);
    onChange({ ...value, colors });
  };
  const hasSuggestion = suggestion && (suggestion.colors.length > 0 || suggestion.shape);
  const accepted =
    hasSuggestion &&
    suggestion.shape === value.shape &&
    suggestion.colors.length === value.colors.length &&
    suggestion.colors.every((c) => value.colors.includes(c));

  return (
    <div className="space-y-3">
      <div>
        <p className="text-lg font-bold text-slate-900">What color and shape is it?</p>
        <p className="text-sm text-slate-500">Optional, but it helps find pills we have few photos of.</p>
      </div>

      {reading && <p className="text-xs text-indigo-600 animate-pulse">Looking at the color and shape…</p>}
      {!reading && hasSuggestion && !accepted && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
          <p className="text-sm text-amber-900 flex flex-wrap items-center gap-1.5">
            Our camera thinks it&apos;s
            {suggestion.colors.map((c) => (
              <span key={c} className="inline-flex items-center gap-1 font-bold">
                <span className="w-4 h-4 rounded-full border border-slate-400" style={{ background: swatch(c) }} />
                {nice(c)}
              </span>
            ))}
            {suggestion.shape && <span className="font-bold">· {nice(suggestion.shape)}</span>}
          </p>
          <p className="text-xs text-amber-800">Lighting can change colors. Only use it if it matches your pill.</p>
          <button
            type="button"
            onClick={() => onChange({ colors: suggestion.colors, shape: suggestion.shape })}
            className="px-4 py-2 bg-amber-200 hover:bg-amber-300 text-amber-900 font-semibold rounded-lg text-sm"
          >
            It matches — use it
          </button>
        </div>
      )}

      <div>
        <p className="text-sm font-semibold text-slate-600 mb-1.5">Color (pick 2 if it has two colors)</p>
        <div className="grid grid-cols-4 gap-2">
          {COLOR_OPTIONS.map((c) => {
            const on = value.colors.includes(c.label);
            return (
              <button
                key={c.label}
                type="button"
                aria-pressed={on}
                onClick={() => toggleColor(c.label)}
                className={`flex flex-col items-center gap-1 py-2 rounded-xl border-2 text-xs font-semibold ${
                  on ? "border-indigo-600 bg-indigo-50 text-indigo-900" : "border-slate-200 bg-white text-slate-700"
                }`}
              >
                <span className="w-7 h-7 rounded-full border border-slate-300" style={{ background: c.swatch }} />
                {nice(c.label)}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold text-slate-600 mb-1.5">Shape</p>
        <div className="grid grid-cols-3 gap-2">
          {MAIN_SHAPES.map((s) => (
            <ShapeButton key={s} shape={s} on={value.shape === s} onClick={() => onChange({ ...value, shape: value.shape === s ? null : s })} />
          ))}
        </div>
        <details className="mt-2" open={!!value.shape && !MAIN_SHAPES.includes(value.shape)}>
          <summary className="text-sm text-indigo-700 font-semibold cursor-pointer py-1">Other shapes</summary>
          <div className="grid grid-cols-3 gap-2 mt-2">
            {SHAPE_OPTIONS.filter((s) => !MAIN_SHAPES.includes(s)).map((s) => (
              <ShapeButton key={s} shape={s} on={value.shape === s} onClick={() => onChange({ ...value, shape: value.shape === s ? null : s })} />
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

function ShapeButton({ shape, on, onClick }: { shape: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex flex-col items-center gap-1 py-2 rounded-xl border-2 text-xs font-semibold ${
        on ? "border-indigo-600 bg-indigo-50 text-indigo-900" : "border-slate-200 bg-white text-slate-700"
      }`}
    >
      <span className={on ? "text-indigo-600" : "text-slate-400"}>
        <ShapeIcon shape={shape} size={26} />
      </span>
      {nice(shape)}
    </button>
  );
}
