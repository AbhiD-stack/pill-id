"use client";

import { useCallback, useEffect, useState } from "react";
import {
  deleteReferencePill, getMedications, getReferencePills, medKey, removeMedication, setMedicationTimes,
  type Medication, type ReferencePill,
} from "@/lib/db";
import { SLOTS } from "@/lib/slots";
import { TimePicker } from "./AddToMedsButton";

type Row = { key: string; drugName: string; ndc?: string; med: Medication | null; pills: ReferencePill[] };

// Everything the patient takes, each with its own pill photo (the reference
// for "Check a pill") and when it's taken.
export default function MyMedicines({ onAdd, onChanged }: { onAdd: () => void; onChanged?: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [meds, pills] = await Promise.all([getMedications(), getReferencePills()]);
    const byKey = new Map<string, Row>();
    for (const m of meds) byKey.set(m.key, { key: m.key, drugName: m.drugName, ndc: m.ndc, med: m, pills: [] });
    for (const p of pills) {
      const key = medKey(p.drugName, p.ndc);
      const row = byKey.get(key) ?? { key, drugName: p.drugName, ndc: p.ndc, med: null, pills: [] };
      row.pills.push(p);
      byKey.set(key, row);
    }
    setRows([...byKey.values()].sort((a, b) => a.drugName.localeCompare(b.drugName)));
    onChanged?.();
  }, [onChanged]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (rows === null) return null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">My medicines</h2>
        <p className="text-base text-slate-600 mt-1">
          Set these up once with a caregiver or pharmacist. Each pill&apos;s photo is what &quot;Check a pill&quot; compares
          with. Photos stay on this device.
        </p>
      </div>
      <button onClick={onAdd} className="w-full py-4 bg-indigo-600 text-white text-lg font-bold rounded-2xl">
        + Add a medicine
      </button>

      {rows.length === 0 ? (
        <div className="p-8 text-center border-2 border-dashed border-slate-300 rounded-2xl bg-white text-base text-slate-500">
          No medicines yet. Tap &quot;Add a medicine&quot; and photograph each pill you take.
        </div>
      ) : (
        rows.map((r) => {
          const photo = r.pills[0];
          const preparing = r.pills.length > 0 && r.pills.every((p) => !p.embeddings || p.embeddings.length === 0);
          return (
            <div key={r.key} className="p-4 bg-white border border-slate-200 rounded-2xl space-y-3">
              <div className="flex gap-3">
                {photo ? (
                  <img src={photo.photoDataUrl} alt={r.drugName} className="w-20 h-20 rounded-xl border border-slate-200 object-contain bg-white shrink-0" />
                ) : (
                  <div className="w-20 h-20 rounded-xl border-2 border-dashed border-slate-300 flex items-center justify-center text-center text-[11px] text-slate-400 shrink-0">
                    No photo
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-bold text-slate-900 break-words">{r.drugName}</p>
                  <p className="text-sm text-slate-600">
                    {r.med ? r.med.buckets.map((b) => SLOTS.find((s) => s.key === b)!.label).join(", ") : "As needed"}
                  </p>
                  {photo?.imprint && (
                    <p className="text-sm text-slate-500">
                      Letters: <span className="font-mono">{photo.imprint.replace(/;/g, " ")}</span>
                    </p>
                  )}
                  {!photo && <p className="text-sm text-amber-700">Add a photo so &quot;Check a pill&quot; can recognize it.</p>}
                  {preparing && <p className="text-sm text-amber-700">Being prepared for checking (needs the internet).</p>}
                </div>
              </div>
              <button
                onClick={() => setEditing(editing === r.key ? null : r.key)}
                className="w-full py-2.5 bg-slate-100 rounded-xl text-base font-semibold text-slate-700"
              >
                {editing === r.key ? "Close" : "Change times or remove"}
              </button>
              {editing === r.key && (
                <div className="space-y-3">
                  <TimePicker
                    initial={r.med?.buckets ?? []}
                    saveLabel="Save times"
                    onSave={async (buckets) => {
                      await setMedicationTimes(r.drugName, r.ndc, buckets);
                      setEditing(null);
                      refresh();
                    }}
                  />
                  <button
                    onClick={async () => {
                      if (!confirm(`Remove ${r.drugName} and its photo?`)) return;
                      await removeMedication(r.drugName, r.ndc);
                      for (const p of r.pills) await deleteReferencePill(p.id);
                      setEditing(null);
                      refresh();
                    }}
                    className="w-full py-3 border-2 border-red-300 text-red-700 font-bold rounded-xl"
                  >
                    Remove this medicine
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
