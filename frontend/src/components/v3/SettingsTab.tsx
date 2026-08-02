"use client";

import { useState } from "react";
import { clearMyPills, saveSettings, type V3Settings } from "@/lib/dbV3";

export default function SettingsTab({
  settings,
  onChange,
  onReplayTutorial,
}: {
  settings: V3Settings;
  onChange: (s: V3Settings) => void;
  onReplayTutorial: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState(false);

  const persist = async (next: V3Settings) => {
    setDraft(next);
    await saveSettings(next);
    onChange(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const handleClearMyPills = async () => {
    if (!confirm("Remove all saved medications from My Pills on this device? This can't be undone.")) return;
    setClearing(true);
    await clearMyPills();
    setClearing(false);
    alert("My Pills data cleared.");
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Section title="Camera">
        <Field label="Default photo brightness" hint="Applied automatically when you start a new scan; you can still adjust it per-photo.">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={draft.brightness}
              onChange={(e) => persist({ ...draft, brightness: parseFloat(e.target.value) })}
              className="flex-1"
            />
            <span className="w-10 shrink-0 text-right text-sm text-slate-500">{draft.brightness.toFixed(1)}×</span>
          </div>
        </Field>
      </Section>

      <Section title="Scan results">
        <Field label="Number of matches shown" hint="Between 6 and 10 possible matches per scan.">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={6}
              max={10}
              step={1}
              value={draft.resultCount}
              onChange={(e) => persist({ ...draft, resultCount: parseInt(e.target.value, 10) })}
              className="flex-1"
            />
            <span className="w-6 shrink-0 text-right text-sm text-slate-500">{draft.resultCount}</span>
          </div>
        </Field>
      </Section>

      <Section title="Display">
        <Field label="Text size">
          <div className="grid grid-cols-2 gap-2">
            {(["normal", "large"] as const).map((size) => (
              <button
                key={size}
                onClick={() => persist({ ...draft, textSize: size })}
                className={`rounded-lg border-2 py-2 text-sm font-semibold capitalize transition ${
                  draft.textSize === size
                    ? "border-sky-600 bg-sky-50 text-sky-700"
                    : "border-slate-200 text-slate-600 hover:border-slate-300"
                }`}
              >
                {size}
              </button>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="Pharmacist contact" hint="Used to pre-fill the 'flag to pharmacist' message in My Pills.">
        <Field label="Name">
          <input
            value={draft.pharmacistName}
            onChange={(e) => setDraft((d) => ({ ...d, pharmacistName: e.target.value }))}
            onBlur={() => persist(draft)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder="Optional"
          />
        </Field>
        <Field label="Phone">
          <input
            value={draft.pharmacistPhone}
            onChange={(e) => setDraft((d) => ({ ...d, pharmacistPhone: e.target.value }))}
            onBlur={() => persist(draft)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder="Optional"
          />
        </Field>
      </Section>

      <Section title="Help">
        <button
          onClick={onReplayTutorial}
          className="w-full rounded-lg bg-slate-100 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-200"
        >
          Replay the tutorial
        </button>
      </Section>

      <Section title="Your data & privacy">
        <p className="text-xs leading-relaxed text-slate-500">
          Everything in My Pills and these settings is stored only on this device (in your browser), never uploaded
          to a server or account. Photos you scan to identify a pill are processed to find a match and are not saved
          on our server. This is an experimental pilot tool, not reviewed by an institutional review board (IRB) or
          a HIPAA-covered entity — do not treat it as a medical record, and always confirm with a pharmacist or
          physician.
        </p>
        <button
          onClick={handleClearMyPills}
          disabled={clearing}
          className="mt-3 w-full rounded-lg border border-red-200 bg-red-50 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50"
        >
          {clearing ? "Clearing…" : "Clear all My Pills data on this device"}
        </button>
      </Section>

      {saved && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-lg">
          Saved
        </div>
      )}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-bold text-slate-900">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}
