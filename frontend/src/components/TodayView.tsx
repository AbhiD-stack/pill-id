"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DoseRecord,
  getDoses,
  getMedications,
  localDate,
  Medication,
  getReferencePills,
  medKey,
  setDoseStatus,
  TimeOfDay,
} from "@/lib/db";
import { doseApplies, formatTime, getSlotTimes, setSlotTime, SLOTS, slotState } from "@/lib/slots";
import { speak, vibrate } from "./AudioAlert";

// Today's doses (tap Taken / Skip), adherence over the last 7 days, and
// medication management (times, removal, adding by name).
export default function TodayView({
  onScan,
  onManage,
  onChanged,
}: {
  onScan: () => void;
  onManage: () => void;
  onChanged?: () => void;
}) {
  const [meds, setMeds] = useState<Medication[]>([]);
  const [doses, setDoses] = useState<DoseRecord[]>([]);
  const [times, setTimes] = useState<Record<TimeOfDay, string>>(getSlotTimes());
  const [now, setNow] = useState(new Date());
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const today = localDate(now);

  const refresh = useCallback(async () => {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 6);
    const [m, d, pills] = await Promise.all([getMedications(), getDoses(localDate(weekAgo), localDate()), getReferencePills()]);
    setMeds(m);
    setDoses(d);
    // Each medicine's own pill photo, so the checklist shows WHICH pill to take.
    const byKey: Record<string, string> = {};
    for (const p of pills) byKey[medKey(p.drugName, p.ndc)] ??= p.photoDataUrl;
    setPhotos(byKey);
    onChanged?.();
  }, [onChanged]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const statusOf = (scheduleId: string, date = today) => doses.find((d) => d.scheduleId === scheduleId && d.date === date)?.status;

  async function mark(med: Medication, bucket: TimeOfDay, status: "taken" | "skipped" | null) {
    const entry = med.entries.find((e) => e.bucket === bucket);
    if (!entry) return;
    await setDoseStatus(entry, today, status);
    vibrate(status === "taken" ? [60, 40, 60] : 60);
    refresh();
  }

  // Adherence: of the doses scheduled in the last 7 days (up to now), how
  // many were marked taken. Days before a medication was added don't count.
  const adherence = (() => {
    let due = 0;
    let taken = 0;
    for (let i = 0; i < 7; i++) {
      const day = new Date(now);
      day.setDate(day.getDate() - i);
      const date = localDate(day);
      for (const med of meds) {
        for (const e of med.entries) {
          if (!doseApplies(e, date)) continue;
          if (i === 0 && slotState(e.bucket, now) === "upcoming") continue;
          due++;
          if (statusOf(e.id, date) === "taken") taken++;
        }
      }
    }
    return due ? Math.round((100 * taken) / due) : null;
  })();

  if (meds.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-bold text-slate-900">Today</h2>
        <div className="p-8 text-center border-2 border-dashed border-slate-300 rounded-2xl bg-white space-y-4">
          <p className="text-lg text-slate-600">No medicines set up yet.</p>
          <button onClick={onScan} className="w-full py-4 bg-indigo-600 text-white text-lg font-bold rounded-2xl">
            Set up my medicines
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Today</h2>
          <p className="text-sm text-slate-500">{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>
        </div>
        {adherence !== null && (
          <div className="text-right">
            <p className={`text-2xl font-black ${adherence >= 80 ? "text-emerald-600" : adherence >= 50 ? "text-amber-600" : "text-red-600"}`}>
              {adherence}%
            </p>
            <p className="text-xs text-slate-500">taken, last 7 days</p>
          </div>
        )}
      </div>

      {SLOTS.map((slot) => {
        const slotMeds = meds.filter((m) => m.buckets.includes(slot.key));
        if (slotMeds.length === 0) return null;
        const state = slotState(slot.key, now);
        // Only doses that were on the schedule at this time can be "missed".
        const pending = slotMeds.filter((m) => {
          const e = m.entries.find((x) => x.bucket === slot.key)!;
          return doseApplies(e, today) && !statusOf(e.id);
        });
        const late = state === "overdue" && pending.length > 0;
        // "Done" only when there was a dose to take today and it's been marked.
        const anyApplies = slotMeds.some((m) => doseApplies(m.entries.find((x) => x.bucket === slot.key)!, today));
        return (
          <section key={slot.key} className={`rounded-2xl border-2 bg-white shadow-sm overflow-hidden ${late ? "border-red-400" : "border-slate-200"}`}>
            <div className={`flex items-center justify-between px-4 py-3 ${late ? "bg-red-50" : "bg-slate-50"}`}>
              <p className="text-lg font-bold text-slate-900">
                {slot.icon} {slot.label} <span className="font-normal text-slate-500">· {formatTime(times[slot.key])}</span>
              </p>
              {late ? (
                <span className="text-sm font-bold text-red-700">Missed?</span>
              ) : state === "due" && pending.length > 0 ? (
                <span className="text-sm font-bold text-amber-700">Due now</span>
              ) : pending.length === 0 && anyApplies ? (
                <span className="text-sm font-bold text-emerald-700">✓ Done</span>
              ) : null}
            </div>
            <div className="divide-y divide-slate-100">
              {slotMeds.map((med) => {
                const entry = med.entries.find((e) => e.bucket === slot.key)!;
                const status = statusOf(entry.id);
                return (
                  <div key={entry.id} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      {photos[med.key] && (
                        <img src={photos[med.key]} alt="" className="w-14 h-14 rounded-xl border border-slate-200 object-contain bg-white shrink-0" />
                      )}
                      <p className={`flex-1 text-lg font-semibold min-w-0 break-words ${status ? "text-slate-400 line-through" : "text-slate-900"}`}>
                        {med.drugName}
                      </p>
                      <button
                        onClick={() => speak(`${slot.label}: ${med.drugName}`)}
                        className="shrink-0 px-2 py-1 text-slate-500"
                        aria-label={`Read ${med.drugName} aloud`}
                      >
                        🔊
                      </button>
                    </div>
                    {status ? (
                      <div className="flex items-center justify-between">
                        <span className={`text-base font-bold ${status === "taken" ? "text-emerald-700" : "text-slate-500"}`}>
                          {status === "taken" ? "✓ Taken" : "Skipped"}
                        </span>
                        <button onClick={() => mark(med, slot.key, null)} className="text-sm text-indigo-600 underline">
                          Undo
                        </button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          onClick={() => mark(med, slot.key, "taken")}
                          className="col-span-2 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white text-lg font-bold rounded-xl"
                        >
                          ✓ Taken
                        </button>
                        <button
                          onClick={() => mark(med, slot.key, "skipped")}
                          className="py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-lg font-bold rounded-xl"
                        >
                          Skip
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      <button onClick={onManage} className="w-full py-3.5 bg-slate-100 text-slate-800 text-base font-bold rounded-2xl">
        💊 Add or change my medicines
      </button>

      {/* Dose times */}
      <section className="p-4 bg-white border border-slate-200 rounded-2xl space-y-3">
        <h3 className="text-lg font-bold text-slate-900">Dose times</h3>
        {SLOTS.map((slot) => (
          <label key={slot.key} className="flex items-center justify-between gap-3">
            <span className="text-base text-slate-700">{slot.icon} {slot.label}</span>
            <input
              type="time"
              value={times[slot.key]}
              onChange={(e) => {
                if (!e.target.value) return;
                setSlotTime(slot.key, e.target.value);
                setTimes(getSlotTimes());
              }}
              className="px-3 py-2 border border-slate-300 rounded-xl text-base"
            />
          </label>
        ))}
      </section>
    </div>
  );
}
