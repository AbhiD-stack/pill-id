"use client";

import { openDB, DBSchema, IDBPDatabase } from "idb";

export type TimeOfDay = "morning" | "noon" | "night";

export interface ScheduleEntry {
  id: string; // uuid
  drugName: string;
  ndc?: string;
  bucket: TimeOfDay;
  createdAt: number;
}

export interface LogEntry {
  id: string; // uuid
  drugName: string;
  ndc?: string;
  scannedAt: number;
  bucket: TimeOfDay | null; // which bucket it was matched against, if any
  onSchedule: boolean; // compliance logic result
}

// A pinned "this is what MY actual pill looks like" record -- the point is
// recall safety: generic manufacturers change between refills (different
// color/shape, same drug), which regularly scares patients into thinking a
// pharmacy error happened. Saving a photo + the expected appearance here
// gives the user something concrete to compare a new refill against and
// to show a pharmacist, instead of relying on memory.
export interface ReferencePill {
  id: string; // uuid
  drugName: string;
  ndc?: string;
  imprint?: string;
  color?: string;
  shape?: string;
  photoDataUrl: string; // the user's own captured photo, base64 data URL
  savedAt: number;
  notes?: string;
}

interface PillIDDb extends DBSchema {
  schedule: { key: string; value: ScheduleEntry; indexes: { "by-bucket": string } };
  logs: { key: string; value: LogEntry; indexes: { "by-time": number } };
  referencePills: { key: string; value: ReferencePill };
}

let dbPromise: Promise<IDBPDatabase<PillIDDb>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<PillIDDb>("pill-id-v2", 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const schedule = db.createObjectStore("schedule", { keyPath: "id" });
          schedule.createIndex("by-bucket", "bucket");
          const logs = db.createObjectStore("logs", { keyPath: "id" });
          logs.createIndex("by-time", "scannedAt");
        }
        if (oldVersion < 2) {
          db.createObjectStore("referencePills", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export async function addScheduleEntry(entry: Omit<ScheduleEntry, "id" | "createdAt">) {
  const db = await getDb();
  const full: ScheduleEntry = { ...entry, id: crypto.randomUUID(), createdAt: Date.now() };
  await db.put("schedule", full);
  return full;
}

export async function getSchedule(): Promise<ScheduleEntry[]> {
  const db = await getDb();
  return db.getAll("schedule");
}

export async function deleteScheduleEntry(id: string) {
  const db = await getDb();
  await db.delete("schedule", id);
}

// Compliance logic: if a scan happens well outside the pre-set regimen
// bucket window, flag it as a possible missed/mistimed dose.
const BUCKET_WINDOWS: Record<TimeOfDay, [number, number]> = {
  morning: [5, 11], // 5am - 11am
  noon: [11, 16], // 11am - 4pm
  night: [18, 23], // 6pm - 11pm
};

export function checkCompliance(now: Date, bucket: TimeOfDay | null): boolean {
  if (!bucket) return false;
  const hour = now.getHours();
  const [start, end] = BUCKET_WINDOWS[bucket];
  return hour >= start && hour < end;
}

export async function addLogEntry(entry: Omit<LogEntry, "id">) {
  const db = await getDb();
  const full: LogEntry = { ...entry, id: crypto.randomUUID() };
  await db.put("logs", full);
  return full;
}

export async function getLogs(): Promise<LogEntry[]> {
  const db = await getDb();
  const all = await db.getAll("logs");
  return all.sort((a, b) => b.scannedAt - a.scannedAt);
}

export async function getRecentDrugNames(hours = 24): Promise<string[]> {
  const logs = await getLogs();
  const cutoff = Date.now() - hours * 3600 * 1000;
  return logs.filter((l) => l.scannedAt >= cutoff).map((l) => l.drugName);
}

export async function addReferencePill(entry: Omit<ReferencePill, "id" | "savedAt">) {
  const db = await getDb();
  const full: ReferencePill = { ...entry, id: crypto.randomUUID(), savedAt: Date.now() };
  await db.put("referencePills", full);
  return full;
}

export async function getReferencePills(): Promise<ReferencePill[]> {
  const db = await getDb();
  const all = await db.getAll("referencePills");
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteReferencePill(id: string) {
  const db = await getDb();
  await db.delete("referencePills", id);
}
