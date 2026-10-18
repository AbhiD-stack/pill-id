"use client";

import { useMemo, useState } from "react";
import { localDate } from "@/lib/db";
import {
  defaultTimes, describePlan, formatTime, intervalLabel, intervalTimes, isValidPlan, parseDate, scheduleWarnings,
  WEEKDAYS, type Frequency,
} from "@/lib/schedule";

type Choice = "1" | "2" | "3" | "4" | "interval" | "every-days" | "weekly" | "every-2-weeks" | "monthly";

const CHOICES: { key: Choice; label: string }[] = [
  { key: "1", label: "Once a day" },
  { key: "2", label: "Twice a day" },
  { key: "3", label: "3 times a day" },
  { key: "4", label: "4 times a day" },
  { key: "interval", label: "Every few hours" },
  { key: "every-days", label: "Every other day" },
  { key: "weekly", label: "Certain days of the week" },
  { key: "every-2-weeks", label: "Every 2 weeks" },
  { key: "monthly", label: "Once a month" },
];

const INTERVALS = [30, 60, 120, 180, 240, 360, 480, 720];

function choiceOf(f: Frequency | null): Choice | null {
  if (!f) return null;
  switch (f.kind) {
    case "daily":
      return f.times.length <= 4 ? (String(f.times.length) as Choice) : "1";
    case "interval":
      return "interval";
    case "every-days":
      return "every-days";
    case "weekly":
      return f.everyWeeks === 2 ? "every-2-weeks" : "weekly";
    case "monthly":
      return "monthly";
  }
}

const timesFor = (f: Frequency | null, n: number) =>
  f && "times" in f && f.times.length === n ? f.times : defaultTimes(n);

// How often and at what exact times a medicine is taken.
export default function SchedulePicker({
  drugName,
  initial,
  onSave,
  saveLabel = "Save",
}: {
  drugName: string;
  initial: Frequency | null;
  onSave: (plan: Frequency) => void | Promise<void>;
  saveLabel?: string;
}) {
  const today = localDate();
  const [choice, setChoice] = useState<Choice | null>(choiceOf(initial));
  const [times, setTimes] = useState<string[]>(initial && "times" in initial ? initial.times : ["08:00"]);
  const [minutes, setMinutes] = useState(initial?.kind === "interval" ? initial.minutes : 240);
  const [start, setStart] = useState(initial?.kind === "interval" ? initial.start : "08:00");
  const [end, setEnd] = useState(initial?.kind === "interval" ? initial.end : "20:00");
  const [aroundClock, setAroundClock] = useState(initial?.kind === "interval" && initial.start === initial.end);
  const [everyDays, setEveryDays] = useState(initial?.kind === "every-days" ? initial.days : 2);
  const [weekdays, setWeekdays] = useState<number[]>(initial?.kind === "weekly" ? initial.weekdays : []);
  const [startDate, setStartDate] = useState(
    initial && (initial.kind === "every-days" || initial.kind === "weekly") ? initial.startDate : today,
  );
  const [dayOfMonth, setDayOfMonth] = useState(initial?.kind === "monthly" ? initial.dayOfMonth : parseDate(today).getDate());

  function pick(c: Choice) {
    setChoice(c);
    const n = ["1", "2", "3", "4"].includes(c) ? Number(c) : 1;
    setTimes(timesFor(initial, n));
    if (c === "every-days") setEveryDays(initial?.kind === "every-days" ? initial.days : 2);
  }

  const plan: Frequency | null = useMemo(() => {
    switch (choice) {
      case null:
        return null;
      case "1":
      case "2":
      case "3":
      case "4":
        return { kind: "daily", times };
      case "interval":
        return { kind: "interval", minutes, start, end: aroundClock ? start : end };
      case "every-days":
        return { kind: "every-days", days: everyDays, times, startDate };
      case "weekly":
        return { kind: "weekly", weekdays, everyWeeks: 1, times, startDate: today };
      case "every-2-weeks":
        return { kind: "weekly", weekdays: [parseDate(startDate).getDay()], everyWeeks: 2, times, startDate };
      case "monthly":
        return { kind: "monthly", dayOfMonth, times };
    }
  }, [choice, times, minutes, start, end, aroundClock, everyDays, startDate, weekdays, dayOfMonth, today]);

  const valid = !!plan && isValidPlan(plan);
  const warnings = scheduleWarnings(drugName, plan);
  const fixedCount = choice && ["1", "2", "3", "4"].includes(choice);

  const timeInputs = (
    <div className="space-y-2">
      <p className="text-base font-bold text-slate-900">At what time{times.length > 1 ? "s" : ""}?</p>
      {times.map((t, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="time"
            value={t}
            aria-label={`Time ${i + 1}`}
            onChange={(e) => e.target.value && setTimes((ts) => ts.map((x, j) => (j === i ? e.target.value : x)))}
            className="flex-1 px-3 py-3 border-2 border-slate-300 rounded-xl text-lg"
          />
          {!fixedCount && times.length > 1 && (
            <button type="button" onClick={() => setTimes((ts) => ts.filter((_, j) => j !== i))} className="px-3 py-3 text-slate-500 underline">
              Remove
            </button>
          )}
        </div>
      ))}
      {!fixedCount && times.length < 6 && (
        <button type="button" onClick={() => setTimes((ts) => [...ts, "20:00"])} className="text-sm text-indigo-700 underline">
          + Add another time that day
        </button>
      )}
      <p className="text-xs text-slate-500">
        Tip: tie each dose to something you do every day, like breakfast or bedtime. It makes doses easier to remember.
      </p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-base font-bold text-slate-900">How often do you take it? (check the pharmacy label)</p>
        <div className="grid grid-cols-2 gap-2">
          {CHOICES.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={choice === c.key}
              onClick={() => pick(c.key)}
              className={`py-3 px-2 rounded-xl border-2 text-base font-bold leading-tight ${
                choice === c.key ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-slate-300 text-slate-700"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {choice === "interval" && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-base font-bold text-slate-900">How often?</span>
            <select
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="mt-1 w-full px-3 py-3 border-2 border-slate-300 rounded-xl text-lg bg-white"
            >
              {INTERVALS.map((m) => (
                <option key={m} value={m}>{intervalLabel(m)}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-3">
            <input type="checkbox" checked={aroundClock} onChange={(e) => setAroundClock(e.target.checked)} className="w-6 h-6" />
            <span className="text-base text-slate-800">Around the clock (also during the night)</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-sm font-bold text-slate-700">{aroundClock ? "Starting at" : "From"}</span>
              <input type="time" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} className="mt-1 w-full px-3 py-3 border-2 border-slate-300 rounded-xl text-lg" />
            </label>
            {!aroundClock && (
              <label className="block">
                <span className="text-sm font-bold text-slate-700">Until</span>
                <input type="time" value={end} onChange={(e) => e.target.value && setEnd(e.target.value)} className="mt-1 w-full px-3 py-3 border-2 border-slate-300 rounded-xl text-lg" />
              </label>
            )}
          </div>
          {plan?.kind === "interval" && valid && (
            <p className="text-sm text-slate-600">
              {intervalTimes(plan).length} doses a day: {intervalTimes(plan).slice(0, 8).map(formatTime).join(", ")}
              {intervalTimes(plan).length > 8 ? ", …" : ""}
            </p>
          )}
        </div>
      )}

      {choice === "every-days" && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-base font-bold text-slate-900">Every how many days?</span>
            <select
              value={everyDays}
              onChange={(e) => setEveryDays(Number(e.target.value))}
              className="mt-1 w-full px-3 py-3 border-2 border-slate-300 rounded-xl text-lg bg-white"
            >
              {[2, 3, 4, 5, 6].map((d) => (
                <option key={d} value={d}>{d === 2 ? "Every other day" : `Every ${d} days`}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-base font-bold text-slate-900">Starting on</span>
            <input type="date" value={startDate} onChange={(e) => e.target.value && setStartDate(e.target.value)} className="mt-1 w-full px-3 py-3 border-2 border-slate-300 rounded-xl text-lg" />
          </label>
          {timeInputs}
        </div>
      )}

      {choice === "weekly" && (
        <div className="space-y-3">
          <p className="text-base font-bold text-slate-900">On which day{weekdays.length === 1 ? "" : "s"}?</p>
          <div className="grid grid-cols-2 gap-2">
            {WEEKDAYS.map((d, i) => {
              const on = weekdays.includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setWeekdays((w) => (on ? w.filter((x) => x !== i) : [...w, i].sort()))}
                  className={`py-3 rounded-xl border-2 text-base font-bold ${on ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-slate-300 text-slate-700"}`}
                >
                  {d}
                </button>
              );
            })}
          </div>
          {timeInputs}
        </div>
      )}

      {choice === "every-2-weeks" && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-base font-bold text-slate-900">Date of the next dose</span>
            <input type="date" value={startDate} onChange={(e) => e.target.value && setStartDate(e.target.value)} className="mt-1 w-full px-3 py-3 border-2 border-slate-300 rounded-xl text-lg" />
            <span className="text-sm text-slate-600">Then every 2 weeks on a {WEEKDAYS[parseDate(startDate).getDay()]}.</span>
          </label>
          {timeInputs}
        </div>
      )}

      {choice === "monthly" && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-base font-bold text-slate-900">On which day of the month?</span>
            <select
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Number(e.target.value))}
              className="mt-1 w-full px-3 py-3 border-2 border-slate-300 rounded-xl text-lg bg-white"
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            {dayOfMonth > 28 && <span className="text-sm text-slate-600">In shorter months, on the last day.</span>}
          </label>
          {timeInputs}
        </div>
      )}

      {fixedCount && timeInputs}

      {plan && valid && (
        <p className="text-base font-semibold text-slate-900 bg-slate-50 border border-slate-200 rounded-xl p-3">
          {describePlan(plan)}
        </p>
      )}
      {choice === "weekly" && weekdays.length === 0 && <p className="text-sm text-amber-800">Pick at least one day.</p>}
      {fixedCount && new Set(times).size !== times.length && <p className="text-sm text-amber-800">Two doses have the same time.</p>}

      {warnings.map((w) => (
        <p key={w} className="text-sm font-semibold text-red-900 bg-red-50 border-2 border-red-300 rounded-xl p-3">⚠ {w}</p>
      ))}

      <button
        type="button"
        disabled={!valid}
        onClick={() => plan && onSave(plan)}
        className="w-full py-3.5 bg-emerald-600 disabled:bg-slate-300 text-white text-lg font-bold rounded-xl"
      >
        {saveLabel}
      </button>
    </div>
  );
}
