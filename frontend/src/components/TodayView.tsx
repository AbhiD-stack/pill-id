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
} from "@/lib/db";
import { describePlan, doseState, dosesOn, formatTime, nextDoseDate, type DoseSlot } from "@/lib/schedule";
import { speak, vibrate } from "./AudioAlert";

type Item = { med: Medication; slot: DoseSlot };

// Today's doses in time order (tap Taken / Skip), what's coming on other
// days, and adherence over the last 7 days.
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

  const statusOf = (doseId: string, date = today) => doses.find((d) => d.doseId === doseId && d.date === date)?.status;

  async function mark(item: Item, status: "taken" | "skipped" | null) {
    await setDoseStatus(item.med, item.slot, today, status);
    vibrate(status === "taken" ? [60, 40, 60] : 60);
    refresh();
  }

  // Adherence: of the doses scheduled in the last 7 days (up to now), how
  // many were marked taken. Doses before a medicine was added don't count.
  const adherence = (() => {
    let due = 0;
    let taken = 0;
    for (let i = 0; i < 7; i++) {
      const day = new Date(now);
      day.setDate(day.getDate() - i);
      const date = localDate(day);
      for (const med of meds) {
        for (const slot of dosesOn(med, date)) {
          if (slot.at > now) continue;
          due++;
          if (statusOf(slot.doseId, date) === "taken") taken++;
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
          <p className="text-lg text-slate-600">No medicines with set times yet.</p>
          <button onClick={onScan} className="w-full py-4 bg-indigo-600 text-white text-lg font-bold rounded-2xl">
            Set up my medicines
          </button>
        </div>
      </div>
    );
  }

  // Today's doses grouped by clock time.
  const groups = new Map<string, Item[]>();
  for (const med of meds) for (const slot of dosesOn(med, today)) groups.set(slot.time, [...(groups.get(slot.time) ?? []), { med, slot }]);
  const times = [...groups.keys()].sort();
  const notToday = meds.filter((m) => dosesOn(m, today).length === 0);

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

      {times.length === 0 && (
        <p className="p-6 text-center bg-white border border-slate-200 rounded-2xl text-base text-slate-600">No doses today.</p>
      )}

      {times.map((time) => {
        const items = groups.get(time)!;
        const pending = items.filter((it) => !statusOf(it.slot.doseId));
        const states = pending.map((it) => doseState(it.slot, it.med.plan, now));
        const late = states.includes("overdue");
        const dueNow = states.includes("due");
        return (
          <section key={time} className={`rounded-2xl border-2 bg-white shadow-sm overflow-hidden ${late ? "border-red-400" : "border-slate-200"}`}>
            <div className={`flex items-center justify-between px-4 py-3 ${late ? "bg-red-50" : "bg-slate-50"}`}>
              <p className="text-lg font-bold text-slate-900">🕒 {formatTime(time)}</p>
              {late ? (
                <span className="text-sm font-bold text-red-700">Missed?</span>
              ) : dueNow ? (
                <span className="text-sm font-bold text-amber-700">Due now</span>
              ) : pending.length === 0 ? (
                <span className="text-sm font-bold text-emerald-700">✓ Done</span>
              ) : null}
            </div>
            <div className="divide-y divide-slate-100">
              {items.map((it) => {
                const status = statusOf(it.slot.doseId);
                return (
                  <div key={it.slot.doseId} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      {photos[it.med.key] && (
                        <img src={photos[it.med.key]} alt="" className="w-14 h-14 rounded-xl border border-slate-200 object-contain bg-white shrink-0" />
                      )}
                      <p className={`flex-1 text-lg font-semibold min-w-0 break-words ${status ? "text-slate-400 line-through" : "text-slate-900"}`}>
                        {it.med.drugName}
                      </p>
                      <button
                        onClick={() => speak(`${formatTime(time)}: ${it.med.drugName}`)}
                        className="shrink-0 px-2 py-1 text-slate-500"
                        aria-label={`Read ${it.med.drugName} aloud`}
                      >
                        🔊
                      </button>
                    </div>
                    {status ? (
                      <div className="flex items-center justify-between">
                        <span className={`text-base font-bold ${status === "taken" ? "text-emerald-700" : "text-slate-500"}`}>
                          {status === "taken" ? "✓ Taken" : "Skipped"}
                        </span>
                        <button onClick={() => mark(it, null)} className="text-sm text-indigo-600 underline">
                          Undo
                        </button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          onClick={() => mark(it, "taken")}
                          className="col-span-2 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white text-lg font-bold rounded-xl"
                        >
                          ✓ Taken
                        </button>
                        <button
                          onClick={() => mark(it, "skipped")}
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

      {notToday.length > 0 && (
        <section className="p-4 bg-white border border-slate-200 rounded-2xl space-y-2">
          <h3 className="text-lg font-bold text-slate-900">Not today</h3>
          {notToday.map((m) => {
            const next = nextDoseDate(m, now);
            return (
              <div key={m.key} className="text-base">
                <p className="font-semibold text-slate-900 break-words">{m.drugName}</p>
                <p className="text-sm text-slate-600">
                  {describePlan(m.plan)}
                  {next && ` · next: ${next.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}`}
                </p>
              </div>
            );
          })}
        </section>
      )}

      <button onClick={onManage} className="w-full py-3.5 bg-slate-100 text-slate-800 text-base font-bold rounded-2xl">
        💊 Add or change my medicines
      </button>
    </div>
  );
}
