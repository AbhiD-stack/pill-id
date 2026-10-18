"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DoseRecord, getDoses, getMedications, getReferencePills, localDate, Medication, medKey, setDoseStatus,
} from "@/lib/db";
import { describePlan, doseState, dosesOn, formatTime, parseDate, type DoseSlot } from "@/lib/schedule";
import { speak, vibrate } from "./AudioAlert";

type View = "week" | "month";
type Item = { med: Medication; slot: DoseSlot };

// One color per medicine, the same everywhere in the calendar (dots in the
// month grid, the list of the day, the key at the bottom).
const MED_COLORS = ["#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#65a30d", "#c026d3", "#475569"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const startOfWeek = (d: Date) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -d.getDay());
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

// The medicine schedule as a calendar: a week (each day listed with every
// dose) or a month (a grid; tap a day to see its doses). Doses today and
// earlier can be marked taken or skipped.
export default function CalendarView({
  onScan,
  onManage,
  onChanged,
}: {
  onScan: () => void;
  onManage: () => void;
  onChanged?: () => void;
}) {
  const [view, setView] = useState<View>("week");
  const [now, setNow] = useState(new Date());
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [selected, setSelected] = useState(() => localDate());
  const [meds, setMeds] = useState<Medication[]>([]);
  const [doses, setDoses] = useState<DoseRecord[]>([]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const today = localDate(now);

  // Visible range: the week, or the whole month grid (with the days of the
  // neighbouring months that fill its first and last rows).
  const { first, days } = useMemo(() => {
    if (view === "week") return { first: anchor, days: Array.from({ length: 7 }, (_, i) => addDays(anchor, i)) };
    const gridStart = startOfWeek(anchor);
    const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const n = Math.ceil(((monthEnd.getTime() - gridStart.getTime()) / 86_400_000 + 1) / 7) * 7;
    return { first: gridStart, days: Array.from({ length: n }, (_, i) => addDays(gridStart, i)) };
  }, [view, anchor]);

  const refresh = useCallback(async () => {
    const weekAgo = addDays(new Date(), -6);
    const from = [localDate(weekAgo), localDate(first)].sort()[0];
    const to = localDate(addDays(first, days.length));
    const [m, d, pills] = await Promise.all([getMedications(), getDoses(from, to), getReferencePills()]);
    setMeds(m);
    setDoses(d);
    const byKey: Record<string, string> = {};
    for (const p of pills) byKey[medKey(p.drugName, p.ndc)] ??= p.photoDataUrl;
    setPhotos(byKey);
    onChanged?.();
  }, [first, days.length, onChanged]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const colorOf = useMemo(() => {
    const map: Record<string, string> = {};
    meds.forEach((m, i) => (map[m.key] = MED_COLORS[i % MED_COLORS.length]));
    return map;
  }, [meds]);

  const statusOf = (doseId: string, date: string) => doses.find((d) => d.doseId === doseId && d.date === date)?.status;
  const itemsOn = (date: string): Item[] =>
    meds
      .flatMap((med) => dosesOn(med, date).map((slot) => ({ med, slot })))
      .sort((a, b) => a.slot.time.localeCompare(b.slot.time) || a.med.drugName.localeCompare(b.med.drugName));
  const missedOn = (date: string) =>
    itemsOn(date).filter((it) => !statusOf(it.slot.doseId, date) && doseState(it.slot, it.med.plan, now) === "overdue").length;

  async function mark(it: Item, date: string, status: "taken" | "skipped" | null) {
    await setDoseStatus(it.med, it.slot, date, status);
    vibrate(status === "taken" ? [60, 40, 60] : 60);
    refresh();
  }

  // Adherence over the last 7 days (doses up to now).
  const adherence = (() => {
    let due = 0;
    let taken = 0;
    for (let i = 0; i < 7; i++) {
      const date = localDate(addDays(now, -i));
      for (const it of itemsOn(date)) {
        if (it.slot.at > now) continue;
        due++;
        if (statusOf(it.slot.doseId, date) === "taken") taken++;
      }
    }
    return due ? Math.round((100 * taken) / due) : null;
  })();

  function go(step: number) {
    setAnchor((a) => (view === "week" ? addDays(a, 7 * step) : new Date(a.getFullYear(), a.getMonth() + step, 1)));
  }
  function goToday() {
    const t = new Date();
    setAnchor(view === "week" ? startOfWeek(t) : startOfMonth(t));
    setSelected(localDate(t));
  }
  function switchView(v: View) {
    const sel = parseDate(selected);
    setView(v);
    setAnchor(v === "week" ? startOfWeek(sel) : startOfMonth(sel));
  }

  if (meds.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-bold text-slate-900">Calendar</h2>
        <div className="p-8 text-center border-2 border-dashed border-slate-300 rounded-2xl bg-white space-y-4">
          <p className="text-lg text-slate-600">No medicines with set times yet.</p>
          <button onClick={onScan} className="w-full py-4 bg-indigo-600 text-white text-lg font-bold rounded-2xl">
            Set up my medicines
          </button>
        </div>
      </div>
    );
  }

  const md = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });
  const title =
    view === "week"
      ? `${md(days[0])} – ${days[6].getMonth() === days[0].getMonth() ? days[6].getDate() : md(days[6])}, ${days[6].getFullYear()}`
      : anchor.toLocaleDateString([], { month: "long", year: "numeric" });
  const showingToday = days.some((d) => localDate(d) === today) && (view === "week" || parseDate(today).getMonth() === anchor.getMonth());

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Calendar</h2>
          <p className="text-sm text-slate-500">Today is {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>
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

      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Calendar view">
        {(["week", "month"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => switchView(v)}
            className={`py-2.5 rounded-xl border-2 text-base font-bold ${view === v ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-slate-300 text-slate-700"}`}
          >
            {v === "week" ? "Week" : "Month"}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => go(-1)} aria-label={`Previous ${view}`} className="w-12 h-12 shrink-0 rounded-xl bg-white border-2 border-slate-300 text-2xl font-bold text-slate-700">
          ‹
        </button>
        <p className="flex-1 text-center text-lg font-bold text-slate-900">{title}</p>
        <button onClick={() => go(1)} aria-label={`Next ${view}`} className="w-12 h-12 shrink-0 rounded-xl bg-white border-2 border-slate-300 text-2xl font-bold text-slate-700">
          ›
        </button>
      </div>
      {!showingToday && (
        <button onClick={goToday} className="w-full py-2.5 bg-indigo-50 border border-indigo-200 text-indigo-800 font-bold rounded-xl">
          Back to today
        </button>
      )}

      {view === "week" ? (
        <div className="space-y-3">
          {days.map((d) => {
            const date = localDate(d);
            return (
              <DayCard
                key={date}
                date={date}
                today={today}
                now={now}
                items={itemsOn(date)}
                statusOf={statusOf}
                colorOf={colorOf}
                photos={photos}
                onMark={mark}
              />
            );
          })}
        </div>
      ) : (
        <>
          <div className="bg-white border border-slate-200 rounded-2xl p-2">
            <div className="grid grid-cols-7 text-center text-xs font-bold text-slate-500 pb-1">
              {WEEKDAY_SHORT.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {days.map((d) => {
                const date = localDate(d);
                const inMonth = d.getMonth() === anchor.getMonth();
                const items = itemsOn(date);
                const medsThatDay = [...new Map(items.map((it) => [it.med.key, it.med])).values()];
                const missed = date <= today ? missedOn(date) : 0;
                const allTaken = items.length > 0 && date <= today && items.every((it) => statusOf(it.slot.doseId, date) === "taken");
                const isToday = date === today;
                const isSel = date === selected;
                return (
                  <button
                    key={date}
                    onClick={() => setSelected(date)}
                    aria-label={`${d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}: ${items.length} dose${items.length === 1 ? "" : "s"}${missed ? `, ${missed} missed` : ""}`}
                    aria-pressed={isSel}
                    className={`min-h-[3.75rem] rounded-xl p-1 flex flex-col items-center gap-1 border-2 ${
                      isSel ? "border-indigo-600 bg-indigo-50" : missed ? "border-red-200 bg-red-50" : allTaken ? "border-emerald-200 bg-emerald-50" : "border-transparent"
                    } ${inMonth ? "" : "opacity-40"}`}
                  >
                    <span
                      className={`text-sm font-bold w-7 h-7 flex items-center justify-center rounded-full ${
                        isToday ? "bg-indigo-600 text-white" : "text-slate-800"
                      }`}
                    >
                      {d.getDate()}
                    </span>
                    <span className="flex flex-wrap justify-center gap-0.5">
                      {medsThatDay.slice(0, 4).map((m) => (
                        <span key={m.key} className="w-2 h-2 rounded-full" style={{ backgroundColor: colorOf[m.key] }} />
                      ))}
                      {medsThatDay.length > 4 && <span className="text-[9px] leading-none text-slate-500">+{medsThatDay.length - 4}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <DayCard
            date={selected}
            today={today}
            now={now}
            items={itemsOn(selected)}
            statusOf={statusOf}
            colorOf={colorOf}
            photos={photos}
            onMark={mark}
          />
        </>
      )}

      <section className="p-4 bg-white border border-slate-200 rounded-2xl space-y-2">
        <h3 className="text-lg font-bold text-slate-900">Your medicines</h3>
        {meds.map((m) => (
          <div key={m.key} className="flex gap-2 items-start">
            <span className="mt-1.5 w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: colorOf[m.key] }} />
            <div className="min-w-0">
              <p className="text-base font-semibold text-slate-900 break-words">{m.drugName}</p>
              <p className="text-sm text-slate-600">
                {m.amount ? `${m.amount} · ` : ""}
                {describePlan(m.plan)}
              </p>
            </div>
          </div>
        ))}
      </section>

      <button onClick={onManage} className="w-full py-3.5 bg-slate-100 text-slate-800 text-base font-bold rounded-2xl">
        💊 Add or change my medicines
      </button>
    </div>
  );
}

function DayCard({
  date,
  today,
  now,
  items,
  statusOf,
  colorOf,
  photos,
  onMark,
}: {
  date: string;
  today: string;
  now: Date;
  items: Item[];
  statusOf: (doseId: string, date: string) => "taken" | "skipped" | undefined;
  colorOf: Record<string, string>;
  photos: Record<string, string>;
  onMark: (it: Item, date: string, status: "taken" | "skipped" | null) => void;
}) {
  const d = parseDate(date);
  const isToday = date === today;
  const future = date > today;
  const taken = items.filter((it) => statusOf(it.slot.doseId, date) === "taken").length;
  const times = [...new Set(items.map((it) => it.slot.time))];

  return (
    <section
      aria-label={d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
      className={`rounded-2xl border-2 bg-white shadow-sm overflow-hidden ${isToday ? "border-indigo-500" : "border-slate-200"}`}
    >
      <div className={`flex items-center justify-between gap-2 px-4 py-2.5 ${isToday ? "bg-indigo-50" : "bg-slate-50"}`}>
        <p className="text-lg font-bold text-slate-900">
          {d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
          {isToday && <span className="ml-2 align-middle text-xs font-bold bg-indigo-600 text-white px-2 py-0.5 rounded-full">TODAY</span>}
        </p>
        {items.length > 0 && !future && (
          <span className="text-sm font-semibold text-slate-600 shrink-0">
            {taken}/{items.length} taken
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-3 text-base text-slate-500">No doses.</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {times.map((time) => (
            <div key={time} className="px-4 py-3 space-y-2">
              <p className="text-sm font-bold text-slate-500">🕒 {formatTime(time)}</p>
              {items
                .filter((it) => it.slot.time === time)
                .map((it) => {
                  const status = statusOf(it.slot.doseId, date);
                  const state = doseState(it.slot, it.med.plan, now);
                  // Today's doses can be marked any time (a pill taken a bit early
                  // counts); past days too, for doses that weren't logged.
                  const canMark = !future;
                  return (
                    <div key={it.slot.doseId} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: colorOf[it.med.key] }} />
                        {photos[it.med.key] && (
                          <img src={photos[it.med.key]} alt="" className="w-10 h-10 rounded-lg border border-slate-200 object-contain bg-white shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className={`text-base font-semibold break-words ${status ? "text-slate-400 line-through" : "text-slate-900"}`}>
                            {it.med.drugName}
                          </p>
                          {it.med.amount && <p className="text-sm text-slate-600">{it.med.amount}</p>}
                        </div>
                        {status === "taken" ? (
                          <span className="text-sm font-bold text-emerald-700 shrink-0">✓ Taken</span>
                        ) : status === "skipped" ? (
                          <span className="text-sm font-bold text-slate-500 shrink-0">Skipped</span>
                        ) : state === "overdue" ? (
                          <span className="text-sm font-bold text-red-700 shrink-0">Missed?</span>
                        ) : state === "due" ? (
                          <span className="text-sm font-bold text-amber-700 shrink-0">Due now</span>
                        ) : null}
                        <button
                          onClick={() => speak(`${formatTime(time)}: ${it.med.drugName}${it.med.amount ? `, ${it.med.amount}` : ""}`)}
                          className="shrink-0 px-1 text-slate-500"
                          aria-label={`Read ${it.med.drugName} aloud`}
                        >
                          🔊
                        </button>
                      </div>
                      {canMark &&
                        (status ? (
                          <button onClick={() => onMark(it, date, null)} className="text-sm text-indigo-600 underline">
                            Undo
                          </button>
                        ) : (
                          <div className="grid grid-cols-3 gap-2">
                            <button
                              onClick={() => onMark(it, date, "taken")}
                              className="col-span-2 py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-base font-bold rounded-xl"
                            >
                              ✓ Taken
                            </button>
                            <button
                              onClick={() => onMark(it, date, "skipped")}
                              className="py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-base font-bold rounded-xl"
                            >
                              Skip
                            </button>
                          </div>
                        ))}
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
