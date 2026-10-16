"use client";

import { useEffect, useState } from "react";
import { getMedications, setMedicationTimes, TimeOfDay } from "@/lib/db";
import { formatTime, getSlotTimes, SLOTS } from "@/lib/slots";
import { vibrate } from "./AudioAlert";

// Big tap targets for choosing which times of day a medicine is taken.
export function TimePicker({
  initial,
  onSave,
  saveLabel = "Save",
}: {
  initial: TimeOfDay[];
  onSave: (buckets: TimeOfDay[]) => void | Promise<void>;
  saveLabel?: string;
}) {
  const [picked, setPicked] = useState<TimeOfDay[]>(initial);
  const times = getSlotTimes();
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-600">When do you take it? Tap all that apply.</p>
      <div className="grid grid-cols-3 gap-2">
        {SLOTS.map((s) => {
          const on = picked.includes(s.key);
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={on}
              onClick={() => setPicked((p) => (on ? p.filter((x) => x !== s.key) : [...p, s.key]))}
              className={`py-3 rounded-xl border-2 text-sm font-bold leading-tight ${
                on ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-slate-300 text-slate-700"
              }`}
            >
              {s.icon} {s.label}
              <span className="block text-[11px] font-normal opacity-80">{formatTime(times[s.key])}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        disabled={picked.length === 0}
        onClick={() => onSave(SLOTS.map((s) => s.key).filter((k) => picked.includes(k)))}
        className="w-full py-3 bg-emerald-600 disabled:bg-slate-300 text-white font-bold rounded-xl"
      >
        {saveLabel}
      </button>
    </div>
  );
}

// "+ Add to my medicines" for a scan result or search result.
export default function AddToMedsButton({
  drugName,
  ndc,
  onAdded,
}: {
  drugName: string;
  ndc?: string | null;
  onAdded?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<TimeOfDay[] | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getMedications().then((meds) => {
      const m = meds.find((x) => x.drugName.trim().toLowerCase() === drugName.trim().toLowerCase() && (x.ndc || "") === (ndc || ""));
      setCurrent(m ? m.buckets : null);
    });
  }, [drugName, ndc, saved]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
          setSaved(false);
        }}
        className={`w-full py-2.5 rounded-xl text-sm font-bold ${
          current ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-indigo-600 text-white"
        }`}
      >
        {current
          ? `✓ In my medicines (${current.map((b) => SLOTS.find((s) => s.key === b)!.label).join(", ")}) · Change`
          : "+ Add to my medicines"}
      </button>
    );
  }
  return (
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl" onClick={(e) => e.stopPropagation()}>
      <TimePicker
        initial={current ?? []}
        saveLabel={current ? "Save times" : "Add to my medicines"}
        onSave={async (buckets) => {
          await setMedicationTimes(drugName, ndc ?? undefined, buckets);
          vibrate([60, 40, 60]);
          setSaved(true);
          setOpen(false);
          onAdded?.();
        }}
      />
      <button type="button" onClick={() => setOpen(false)} className="w-full mt-2 text-sm text-slate-500 underline">
        Cancel
      </button>
    </div>
  );
}
