"use client";

import type { TimeOfDay } from "./db";

// The three daily dose times. Each has an editable clock time (stored on
// this device) used for reminders and for marking doses overdue.
export const SLOTS: { key: TimeOfDay; label: string; icon: string; defaultTime: string }[] = [
  { key: "morning", label: "Morning", icon: "🌅", defaultTime: "08:00" },
  { key: "noon", label: "Midday", icon: "☀️", defaultTime: "13:00" },
  { key: "night", label: "Evening", icon: "🌙", defaultTime: "20:00" },
];

const STORE_KEY = "pillid.slotTimes";

export function getSlotTimes(): Record<TimeOfDay, string> {
  const defaults = Object.fromEntries(SLOTS.map((s) => [s.key, s.defaultTime])) as Record<TimeOfDay, string>;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    for (const s of SLOTS) {
      if (typeof saved[s.key] === "string" && /^\d{2}:\d{2}$/.test(saved[s.key])) defaults[s.key] = saved[s.key];
    }
  } catch {
    // storage unavailable: defaults
  }
  return defaults;
}

export function setSlotTime(slot: TimeOfDay, time: string) {
  try {
    const times = getSlotTimes();
    times[slot] = time;
    localStorage.setItem(STORE_KEY, JSON.stringify(times));
  } catch {
    // storage unavailable: change lasts for this session only
  }
}

// Today's Date at the slot's clock time.
export function slotDateToday(slot: TimeOfDay, now = new Date()): Date {
  const [h, m] = getSlotTimes()[slot].split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d;
}

// The slot's clock time on a given local date (YYYY-MM-DD).
export function slotDateOn(slot: TimeOfDay, date: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, m] = getSlotTimes()[slot].split(":").map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0);
}

// Whether a scheduled dose counts on a date: the medicine must already have
// been on the schedule at that dose's time. (Adding a medicine at 3 PM
// doesn't make that morning's dose "missed".)
export function doseApplies(entry: { bucket: TimeOfDay; createdAt: number }, date: string): boolean {
  return slotDateOn(entry.bucket, date).getTime() >= entry.createdAt;
}

// A dose is "due" from its time until 2 hours later, then "overdue".
export const OVERDUE_AFTER_MS = 2 * 60 * 60 * 1000;

export function slotState(slot: TimeOfDay, now = new Date()): "upcoming" | "due" | "overdue" {
  const t = slotDateToday(slot, now).getTime();
  if (now.getTime() < t) return "upcoming";
  return now.getTime() - t < OVERDUE_AFTER_MS ? "due" : "overdue";
}

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
