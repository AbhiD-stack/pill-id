"use client";

import { useEffect, useState } from "react";
import { getMedications, medKey, setMedicationPlan } from "@/lib/db";
import { describePlan, type Frequency } from "@/lib/schedule";
import SchedulePicker from "./SchedulePicker";
import { vibrate } from "./AudioAlert";

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
  const [current, setCurrent] = useState<Frequency | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getMedications().then((meds) => {
      const m = meds.find((x) => x.key === medKey(drugName, ndc ?? undefined));
      setCurrent(m ? m.plan : null);
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
        className={`w-full py-2.5 px-2 rounded-xl text-sm font-bold ${
          current ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-indigo-600 text-white"
        }`}
      >
        {current ? `✓ In my medicines (${describePlan(current)}) · Change` : "+ Add to my medicines"}
      </button>
    );
  }
  return (
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl" onClick={(e) => e.stopPropagation()}>
      <SchedulePicker
        drugName={drugName}
        initial={current}
        saveLabel={current ? "Save" : "Add to my medicines"}
        onSave={async (plan) => {
          await setMedicationPlan(drugName, ndc ?? undefined, plan);
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
