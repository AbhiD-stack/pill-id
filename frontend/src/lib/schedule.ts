// When each medicine is taken: exact clock times and how often, per
// medicine. Every dose on a given day is computed from the plan, so there is
// nothing to keep in sync.
//
// Choices informed by geriatric medication-safety practice:
//  - Doses default to waking hours, evenly spread (no sleep interruptions
//    unless "around the clock" is chosen), and the setup screen suggests
//    tying each dose to a daily routine (meals, bedtime) -- a well-supported
//    way to improve adherence in older adults.
//  - Once-a-week medicines need the day spelled out, and setting a medicine
//    that is normally weekly/monthly (methotrexate, bisphosphonates) to a
//    daily schedule triggers a warning: taking weekly methotrexate daily is
//    a known cause of fatal overdoses in older adults (ISMP high-alert).
//  - Very frequent schedules (every hour or more often) are flagged for a
//    double check against the label.

export type Frequency =
  // 1-6 set times every day.
  | { kind: "daily"; times: string[] }
  // Every `minutes` from `start` to `end` (same day). start === end means
  // around the clock, starting at `start`.
  | { kind: "interval"; minutes: number; start: string; end: string }
  // Every `days` days at these times, counted from `startDate`.
  | { kind: "every-days"; days: number; times: string[]; startDate: string }
  // On these weekdays (0 = Sunday), every `everyWeeks` weeks counted from
  // the week of `startDate`, at these times.
  | { kind: "weekly"; weekdays: number[]; everyWeeks: number; times: string[]; startDate: string }
  // On this day of the month (last day of shorter months), at these times.
  | { kind: "monthly"; dayOfMonth: number; times: string[] };

export type DoseSlot = { doseId: string; time: string; at: Date };

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const fromMin = (min: number) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
export const isTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function parseDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Evenly spread over waking hours (8 AM to 8 PM), the usual pattern for
// "twice / three / four times a day" (e.g. 8 AM + 8 PM; 8 AM, 2 PM, 8 PM).
export function defaultTimes(n: number): string[] {
  if (n <= 1) return ["08:00"];
  const span = 12 * 60;
  return Array.from({ length: n }, (_, i) => fromMin(8 * 60 + Math.round((span * i) / (n - 1) / 15) * 15));
}

export function intervalTimes(f: { minutes: number; start: string; end: string }): string[] {
  const start = toMin(f.start);
  const step = Math.max(15, f.minutes);
  const last = f.start === f.end ? start + 1440 - 1 : toMin(f.end);
  const out: string[] = [];
  for (let t = start; t <= last && out.length < 96; t += step) out.push(fromMin(t));
  return out;
}

function timesOf(f: Frequency): string[] {
  return f.kind === "interval" ? intervalTimes(f) : [...f.times].sort();
}

function appliesOn(f: Frequency, date: string): boolean {
  switch (f.kind) {
    case "daily":
    case "interval":
      return true;
    case "every-days": {
      const diff = dayNumber(date) - dayNumber(f.startDate);
      return diff >= 0 && diff % Math.max(1, f.days) === 0;
    }
    case "weekly": {
      const d = parseDate(date);
      if (!f.weekdays.includes(d.getDay())) return false;
      // Whole weeks between the Sundays of the two weeks.
      const weekOf = (s: string) => dayNumber(s) - parseDate(s).getDay();
      const weeks = Math.round((weekOf(date) - weekOf(f.startDate)) / 7);
      return weeks >= 0 && weeks % Math.max(1, f.everyWeeks) === 0;
    }
    case "monthly": {
      const d = parseDate(date);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      return d.getDate() === Math.min(f.dayOfMonth, lastDay);
    }
  }
}

// The doses of one medicine on a date (YYYY-MM-DD), earliest first. Doses
// before the medicine was added (createdAt) don't count.
export function dosesOn(med: { key: string; plan: Frequency; createdAt: number }, date: string): DoseSlot[] {
  if (!appliesOn(med.plan, date)) return [];
  const day = parseDate(date);
  return timesOf(med.plan)
    .map((time) => {
      const at = new Date(day);
      at.setHours(Math.floor(toMin(time) / 60), toMin(time) % 60, 0, 0);
      return { doseId: `${med.key}@${time}`, time, at };
    })
    .filter((s) => s.at.getTime() >= med.createdAt);
}

// The next date (from `from`, inclusive) with a dose, within ~2 months.
export function nextDoseDate(med: { key: string; plan: Frequency; createdAt: number }, from: Date): Date | null {
  for (let i = 0; i < 64; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const doses = dosesOn(med, date).filter((s) => s.at >= from);
    if (doses.length) return doses[0].at;
  }
  return null;
}

// A dose is "due" from its time until 2 hours later (or until the next
// dose, for frequent schedules), then "overdue".
export function dueWindowMs(plan: Frequency): number {
  const twoHours = 2 * 60 * 60 * 1000;
  return plan.kind === "interval" ? Math.min(twoHours, plan.minutes * 60 * 1000) : twoHours;
}

export function doseState(slot: DoseSlot, plan: Frequency, now = new Date()): "upcoming" | "due" | "overdue" {
  const t = slot.at.getTime();
  if (now.getTime() < t) return "upcoming";
  return now.getTime() - t < dueWindowMs(plan) ? "due" : "overdue";
}

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const atTimes = (times: string[]) => `at ${list([...times].sort().map(formatTime))}`;

export function intervalLabel(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} minutes`;
  if (minutes === 60) return "Every hour";
  return `Every ${minutes / 60} hours`;
}

export function describePlan(f: Frequency): string {
  switch (f.kind) {
    case "daily": {
      const n = f.times.length;
      const how = n === 1 ? "Once a day" : n === 2 ? "Twice a day" : `${n} times a day`;
      return `${how} ${atTimes(f.times)}`;
    }
    case "interval":
      return f.start === f.end
        ? `${intervalLabel(f.minutes)}, around the clock (from ${formatTime(f.start)})`
        : `${intervalLabel(f.minutes)}, ${formatTime(f.start)} to ${formatTime(f.end)}`;
    case "every-days":
      return `${f.days === 2 ? "Every other day" : `Every ${f.days} days`} ${atTimes(f.times)}`;
    case "weekly": {
      const days = list([...f.weekdays].sort().map((d) => WEEKDAYS[d]));
      return f.everyWeeks === 1 ? `Every ${days} ${atTimes(f.times)}` : `Every ${f.everyWeeks} weeks on ${days} ${atTimes(f.times)}`;
    }
    case "monthly":
      return `Once a month on the ${ordinal(f.dayOfMonth)} ${atTimes(f.times)}`;
  }
}

// ── Safety checks on the schedule itself ───────────────────────────────────
const WEEKLY_DRUGS: { match: RegExp; text: string }[] = [
  {
    match: /methotrexate/i,
    text: "Methotrexate for arthritis or psoriasis is usually taken ONCE A WEEK. Taking it every day by mistake can be fatal. Check the label with your pharmacist before saving.",
  },
  {
    match: /alendronate|risedronate|ibandronate|fosamax|actonel|boniva/i,
    text: "Bone medicines like this one are often taken once a week or once a month, not daily. Check the label to be sure.",
  },
];

const isEveryDay = (f: Frequency) => f.kind === "daily" || f.kind === "interval" || (f.kind === "every-days" && f.days <= 2);

export function scheduleWarnings(drugName: string, f: Frequency | null): string[] {
  if (!f) return [];
  const out: string[] = [];
  if (isEveryDay(f)) for (const w of WEEKLY_DRUGS) if (w.match.test(drugName)) out.push(w.text);
  if (f.kind === "interval" && f.minutes <= 60) {
    out.push("A pill every hour or more often is unusual. Please double-check the label or ask your pharmacist.");
  }
  if (timesOf(f).length > 6 && f.kind !== "interval") out.push("That's a lot of doses in one day. Please double-check the label.");
  return out;
}

export function isValidPlan(f: Frequency): boolean {
  switch (f.kind) {
    case "daily":
      return f.times.length > 0 && f.times.every(isTime) && new Set(f.times).size === f.times.length;
    case "interval":
      return f.minutes >= 15 && isTime(f.start) && isTime(f.end) && (f.start === f.end || toMin(f.end) > toMin(f.start));
    case "every-days":
      return f.days >= 2 && f.times.length > 0 && f.times.every(isTime) && /^\d{4}-\d{2}-\d{2}$/.test(f.startDate);
    case "weekly":
      return f.weekdays.length > 0 && f.everyWeeks >= 1 && f.times.length > 0 && f.times.every(isTime) && /^\d{4}-\d{2}-\d{2}$/.test(f.startDate);
    case "monthly":
      return f.dayOfMonth >= 1 && f.dayOfMonth <= 31 && f.times.length > 0 && f.times.every(isTime);
  }
}
