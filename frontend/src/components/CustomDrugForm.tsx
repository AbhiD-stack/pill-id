"use client";

import { useState } from "react";
import { addCustomDrug, type CustomDrug } from "@/lib/db";
import type { SearchResult } from "@/lib/api";
import { COLOR_OPTIONS, SCORE_MARK_LABELS, SCORE_MARK_OPTIONS, SHAPE_OPTIONS } from "@/lib/pillAppearance";
import { ShapeIcon } from "./PillSearchPanel";
import PillDrawing, { canDrawPill } from "./PillDrawing";

// A medicine the user typed in, as a search result (shown with the rest,
// clearly marked as not from the FDA list).
export function customToResult(d: CustomDrug): SearchResult {
  return {
    label: `custom:${d.id}`,
    ndc: null,
    name: d.name,
    imprint: d.imprint ?? null,
    color: d.color ?? null,
    shape: d.shape ?? null,
    score_marks: d.scoreMarks ?? null,
    reference_image_url: null,
    reference_image_kind: null,
    custom: true,
  };
}

// "Can't find it? Add it yourself": name (from the pharmacy label) plus
// whatever the user can see on the pill. Saved on this device only.
export default function CustomDrugForm({
  initialName = "",
  initialImprint = "",
  initialColors = [],
  initialShape = null,
  onSaved,
  onCancel,
}: {
  initialName?: string;
  initialImprint?: string;
  initialColors?: string[];
  initialShape?: string | null;
  onSaved: (result: SearchResult) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [strength, setStrength] = useState("");
  const [colors, setColors] = useState<string[]>(initialColors.slice(0, 2));
  const [shape, setShape] = useState<string | null>(initialShape);
  const [imprint1, setImprint1] = useState(initialImprint);
  const [imprint2, setImprint2] = useState("");
  const [scoreMarks, setScoreMarks] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fullName = [name.trim(), strength.trim()].filter(Boolean).join(" ");
  const imprint = [imprint1, imprint2].map((s) => s.trim().toUpperCase().replace(/\s+/g, ";")).filter(Boolean).join(";");
  const look = { imprint, color: colors.join(","), shape, scoreMarks };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2 || saving) return;
    setSaving(true);
    try {
      const d = await addCustomDrug({
        name: fullName,
        imprint: imprint || undefined,
        color: colors.length ? colors.join(",") : undefined,
        shape: shape ?? undefined,
        scoreMarks: scoreMarks ?? undefined,
      });
      onSaved(customToResult(d));
    } catch (err) {
      console.error("Saving the medicine failed:", err);
      setError("Couldn't save on this device. Check that the browser allows site storage and try again.");
      setSaving(false);
    }
  }

  const chip = (on: boolean) =>
    `flex flex-col items-center gap-0.5 px-2.5 py-2 rounded-xl border text-[10px] font-medium ${
      on ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-slate-200 text-slate-600"
    }`;

  return (
    <form onSubmit={save} className="p-4 bg-white border-2 border-indigo-200 rounded-2xl space-y-4">
      <div>
        <h3 className="text-lg font-bold text-slate-900">Add a medicine that isn&apos;t listed</h3>
        <p className="text-sm text-slate-600">
          Copy the name exactly as it is on the pharmacy label. It&apos;s saved on this device only, and marked as
          entered by you.
        </p>
      </div>

      <label className="block">
        <span className="text-sm font-bold text-slate-700">Medicine name (required)</span>
        <input
          type="text"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Metformin"
          className="mt-1 w-full px-3 py-3 border-2 border-slate-300 rounded-xl text-base"
        />
      </label>
      <label className="block">
        <span className="text-sm font-bold text-slate-700">Strength (optional)</span>
        <input
          type="text"
          value={strength}
          maxLength={30}
          onChange={(e) => setStrength(e.target.value)}
          placeholder="e.g. 500 mg"
          className="mt-1 w-full px-3 py-3 border-2 border-slate-300 rounded-xl text-base"
        />
      </label>

      <div>
        <p className="text-sm font-bold text-slate-700 mb-1.5">Color (up to 2)</p>
        <div className="flex flex-wrap gap-2">
          {COLOR_OPTIONS.map((c) => {
            const on = colors.includes(c.label);
            return (
              <button
                key={c.label}
                type="button"
                aria-pressed={on}
                onClick={() => setColors((cs) => (on ? cs.filter((x) => x !== c.label) : [...cs, c.label].slice(-2)))}
                className={chip(on)}
              >
                <span className="w-5 h-5 rounded-full border border-slate-300" style={{ backgroundColor: c.swatch }} />
                {c.label.toLowerCase()}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-sm font-bold text-slate-700 mb-1.5">Shape</p>
        <div className="flex flex-wrap gap-2">
          {SHAPE_OPTIONS.map((s) => (
            <button key={s} type="button" aria-pressed={shape === s} onClick={() => setShape(shape === s ? null : s)} className={chip(shape === s)}>
              <ShapeIcon shape={s} size={22} />
              {s.split(" ")[0].toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-bold text-slate-700 mb-1.5">Letters or numbers on the pill</p>
        <div className="grid grid-cols-2 gap-2">
          <input type="text" value={imprint1} maxLength={30} onChange={(e) => setImprint1(e.target.value)} placeholder="Side 1" className="px-3 py-3 border-2 border-slate-300 rounded-xl text-base" />
          <input type="text" value={imprint2} maxLength={30} onChange={(e) => setImprint2(e.target.value)} placeholder="Side 2" className="px-3 py-3 border-2 border-slate-300 rounded-xl text-base" />
        </div>
      </div>

      <div>
        <p className="text-sm font-bold text-slate-700 mb-1.5">Score lines</p>
        <div className="flex flex-wrap gap-2">
          {SCORE_MARK_OPTIONS.map((s) => (
            <button key={s} type="button" aria-pressed={scoreMarks === s} onClick={() => setScoreMarks(scoreMarks === s ? null : s)} className={chip(scoreMarks === s)}>
              {SCORE_MARK_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      {canDrawPill(look) && (
        <div className="flex items-center gap-3">
          <div className="w-20 h-20 shrink-0 p-1 border border-slate-200 rounded-xl">
            <PillDrawing look={look} title="Drawing of the pill you described" />
          </div>
          <p className="text-sm text-slate-600">Drawing of the pill you described. Check it looks like yours.</p>
        </div>
      )}

      <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-xl p-2.5">
        This medicine isn&apos;t in the FDA list, so the app can&apos;t confirm what it looks like. Safety checks use the
        name you type. Ask your pharmacist if you&apos;re unsure of the exact name.
      </p>
      {error && <p className="text-sm text-red-800">{error}</p>}

      <button
        type="submit"
        disabled={name.trim().length < 2 || saving}
        className="w-full py-3.5 bg-indigo-600 disabled:bg-slate-300 text-white text-base font-bold rounded-xl"
      >
        {saving ? "Saving…" : "Save this medicine"}
      </button>
      <button type="button" onClick={onCancel} className="w-full text-sm text-slate-500 underline">
        Cancel
      </button>
    </form>
  );
}
