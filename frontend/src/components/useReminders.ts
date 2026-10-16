"use client";

import { useCallback, useEffect, useState } from "react";
import { getDoses, getMedications, localDate, TimeOfDay } from "@/lib/db";
import { doseApplies, SLOTS, slotState } from "@/lib/slots";
import { vibrate } from "./AudioAlert";

export interface DueReminder {
  slot: TimeOfDay;
  label: string;
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
    const done = new Set(doses.map((d) => d.scheduleId));
    let found: DueReminder | null = null;
    for (const slot of SLOTS) {
      const state = slotState(slot.key, now);
      if (state === "upcoming") continue;
      const pending = meds.filter((m) =>
        m.entries.some((e) => e.bucket === slot.key && !done.has(e.id) && doseApplies(e, today)));
      if (pending.length === 0 || storageGet(dismissedKey(today, slot.key))) continue;
      found = { slot: slot.key, label: slot.label, meds: pending.map((m) => m.drugName), overdue: state === "overdue" };
      // First time this dose time comes up today: alert once.
      if (!storageGet(seenKey(today, slot.key))) {
        storageSet(seenKey(today, slot.key), "1");
        vibrate([300, 150, 300]);
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification(`Time for your ${slot.label.toLowerCase()} medicines`, {
              body: found.meds.join(", "),
              tag: `pillid-${today}-${slot.key}`,
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
    if (due) storageSet(dismissedKey(localDate(), due.slot), "1");
    setDue(null);
  }, [due]);

  const enableNotifications = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    setPermission(await Notification.requestPermission());
  }, []);

  return { due, dismiss, permission, enableNotifications, recheck: check };
}
