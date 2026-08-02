"use client";

// Device-local storage for the V3 UI: "My Pills" saved personal reference
// photos and app settings. Everything here lives only in this browser's
// IndexedDB -- nothing is uploaded to any server, and there is no login/user
// account system. Clearing browser data (or using a different device/browser)
// loses it, same as any other localStorage/IndexedDB-backed app.
//
// This is a separate database from lib/db.ts (v2's schedule/logs store) so
// V3 stays fully independent of v1/v2, per the app's version-isolation design.
import { openDB, DBSchema, IDBPDatabase } from "idb";

export interface MyPillEntry {
  id: string;
  // Identity of the medication this personal photo is filed under.
  label: string;
  ndc: string | null;
  name: string | null;
  // A snapshot of the *officially registered* appearance at save time, so a
  // later re-fetch can be diffed against it to notice a manufacturer/appearance
  // change (recall, new supplier, etc.) -- see checkForAppearanceChange().
  officialSnapshot: {
    imprint: string | null;
    color: string | null;
    shape: string | null;
    referenceImageUrl: string | null;
    fetchedAt: number;
  };
  // The user's own photo of their pill, as a data URL (kept small -- see
  // MAX_PHOTO_DIMENSION in CaptureCropper).
  personalPhotoDataUrl: string;
  notes: string;
  savedAt: number;
  // Set once the user has seen and acknowledged a detected appearance change,
  // so the same alert doesn't nag every time they open the tab.
  changeAcknowledged: boolean;
}

export interface V3Settings {
  id: "singleton";
  brightness: number; // 0.5-2.0, applied as a canvas filter at capture time
  resultCount: number; // 6-10, how many scan matches to show
  textSize: "normal" | "large";
  pharmacistName: string;
  pharmacistPhone: string;
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: V3Settings = {
  id: "singleton",
  brightness: 1.0,
  resultCount: 8,
  textSize: "normal",
  pharmacistName: "",
  pharmacistPhone: "",
  onboarded: false,
};

interface PillIDV3Db extends DBSchema {
  myPills: { key: string; value: MyPillEntry; indexes: { "by-saved": number } };
  settings: { key: string; value: V3Settings };
}

let dbPromise: Promise<IDBPDatabase<PillIDV3Db>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<PillIDV3Db>("pill-id-v3", 1, {
      upgrade(db) {
        const myPills = db.createObjectStore("myPills", { keyPath: "id" });
        myPills.createIndex("by-saved", "savedAt");
        db.createObjectStore("settings", { keyPath: "id" });
      },
    });
  }
  return dbPromise;
}

export async function addMyPill(entry: Omit<MyPillEntry, "id" | "savedAt" | "changeAcknowledged">) {
  const db = await getDb();
  const full: MyPillEntry = {
    ...entry,
    id: crypto.randomUUID(),
    savedAt: Date.now(),
    changeAcknowledged: false,
  };
  await db.put("myPills", full);
  return full;
}

export async function updateMyPill(entry: MyPillEntry) {
  const db = await getDb();
  await db.put("myPills", entry);
}

export async function getMyPills(): Promise<MyPillEntry[]> {
  const db = await getDb();
  const all = await db.getAll("myPills");
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteMyPill(id: string) {
  const db = await getDb();
  await db.delete("myPills", id);
}

export async function clearMyPills() {
  const db = await getDb();
  await db.clear("myPills");
}

export async function getSettings(): Promise<V3Settings> {
  const db = await getDb();
  const existing = await db.get("settings", "singleton");
  return existing ?? DEFAULT_SETTINGS;
}

export async function saveSettings(settings: V3Settings) {
  const db = await getDb();
  await db.put("settings", settings);
}

// Compares a freshly-fetched "official" appearance against the snapshot taken
// when the pill was saved. A change here doesn't necessarily mean anything is
// wrong (RxNav data can simply be missing a field), but a solid mismatch on a
// field that WAS populated both times is worth flagging for the user to raise
// with a pharmacist -- that's the whole point of this tab.
export function detectAppearanceChange(
  saved: MyPillEntry["officialSnapshot"],
  current: { imprint: string | null; color: string | null; shape: string | null }
): string[] {
  const changes: string[] = [];
  const fields: Array<["imprint" | "color" | "shape", string]> = [
    ["imprint", "Imprint"],
    ["color", "Color"],
    ["shape", "Shape"],
  ];
  for (const [key, label] of fields) {
    const before = saved[key];
    const after = current[key];
    if (before && after && before.trim().toLowerCase() !== after.trim().toLowerCase()) {
      changes.push(`${label} changed from "${before}" to "${after}"`);
    }
  }
  return changes;
}
