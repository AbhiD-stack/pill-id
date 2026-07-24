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

interface PillIDDb extends DBSchema {
  schedule: { key: string; value: ScheduleEntry; indexes: { "by-bucket": string } };
  logs: { key: string; value: LogEntry; indexes: { "by-time": number } };
}

let dbPromise: Promise<IDBPDatabase<PillIDDb>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<PillIDDb>("pill-id-v2", 1, {
      upgrade(db) {
        const schedule = db.createObjectStore("schedule", { keyPath: "id" });
        schedule.createIndex("by-bucket", "bucket");
        const logs = db.createObjectStore("logs", { keyPath: "id" });
        logs.createIndex("by-time", "scannedAt");
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
