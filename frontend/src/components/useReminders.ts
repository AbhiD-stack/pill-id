"use client";

import { useCallback, useEffect, useState } from "react";
import { getDoses, getMedications, localDate } from "@/lib/db";
import { doseState, dosesOn, formatTime } from "@/lib/schedule";
import { vibrate } from "./AudioAlert";

export interface DueReminder {
  time: string; // HH:MM
  label: string; // e.g. "8:00 AM"
  meds: string[];
  overdue: boolean;
}

const seenKey = (date: string, slot: string) => `pillid.reminded.${date}.${slot}`;
const dismissedKey = (date: string, slot: string) => `pillid.dismissed.${date}.${slot}`;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

// Checks every 30s for doses that are due and not yet marked taken or
// skipped. When a dose time arrives: an in-app banner, a vibration, and --
// if the user allowed notifications -- a system notification. Works while
// the app is open (or installed to the home screen and running); it can't
// wake a closed browser, which needs a native app or push server.
export function useReminders(refreshKey: number) {
  const [due, setDue] = useState<DueReminder | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");

  useEffect(() => {
    setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, []);

  const check = useCallback(async () => {
    const now = new Date();
    const today = localDate(now);
    const [meds, doses] = await Promise.all([getMedications(), getDoses(today, today)]);
    const done = new Set(doses.map((d) => d.doseId));
    // Doses that have come up today and aren't marked, by clock time.
    const byTime = new Map<string, { meds: string[]; overdue: boolean }>();
    for (const m of meds) {
      for (const slot of dosesOn(m, today)) {
        const state = doseState(slot, m.plan, now);
        if (state === "upcoming" || done.has(slot.doseId)) continue;
        const g = byTime.get(slot.time) ?? { meds: [], overdue: true };
        g.meds.push(m.drugName);
        g.overdue &&= state === "overdue";
        byTime.set(slot.time, g);
      }
    }
    let found: DueReminder | null = null;
    // The most recent dose time first: that's the one to take now.
    for (const time of [...byTime.keys()].sort().reverse()) {
      if (storageGet(dismissedKey(today, time))) continue;
      const g = byTime.get(time)!;
      found = { time, label: formatTime(time), meds: g.meds, overdue: g.overdue };
      // First time this dose time comes up today: alert once.
      if (!storageGet(seenKey(today, time))) {
        storageSet(seenKey(today, time), "1");
        vibrate([300, 150, 300]);
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification(`Time for your ${found.label} medicines`, {
              body: found.meds.join(", "),
              tag: `pillid-${today}-${time}`,
            });
          } catch {
            // some mobile browsers only allow notifications from a service worker
          }
        }
      }
      break;
    }
    setDue(found);
  }, []);

  useEffect(() => {
    check();
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, [check, refreshKey]);

  const dismiss = useCallback(() => {
    if (due) storageSet(dismissedKey(localDate(), due.time), "1");
    setDue(null);
  }, [due]);

  const enableNotifications = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    setPermission(await Notification.requestPermission());
  }, []);

  return { due, dismiss, permission, enableNotifications, recheck: check };
}
