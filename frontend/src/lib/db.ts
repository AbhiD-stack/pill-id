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
  // Model embeddings of the photo(s) (front, then back if captured). Future
  // scans are compared against these on-device ("My Pills" matching).
  // Missing on pills saved before that existed -- backfilled via /api/embed.
  embeddings?: number[][];
  savedAt: number;
  notes?: string;
}

// One dose of one scheduled medication on one day: taken or skipped. A
// dose with no record is still pending (or missed, once its time passes).
export type DoseStatus = "taken" | "skipped";
export interface DoseRecord {
  id: string; // `${date}|${scheduleEntryId}`
  scheduleId: string;
  drugName: string;
  date: string; // YYYY-MM-DD, local time
  bucket: TimeOfDay;
  status: DoseStatus;
  at: number;
}

interface PillIDDb extends DBSchema {
  schedule: { key: string; value: ScheduleEntry; indexes: { "by-bucket": string } };
  logs: { key: string; value: LogEntry; indexes: { "by-time": number } };
  referencePills: { key: string; value: ReferencePill };
  doses: { key: string; value: DoseRecord; indexes: { "by-date": string } };
}

let dbPromise: Promise<IDBPDatabase<PillIDDb>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<PillIDDb>("pill-id-v2", 3, {
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
        if (oldVersion < 3) {
          const doses = db.createObjectStore("doses", { keyPath: "id" });
          doses.createIndex("by-date", "date");
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

export async function updateReferencePill(pill: ReferencePill) {
  const db = await getDb();
  await db.put("referencePills", pill);
}

export async function deleteReferencePill(id: string) {
  const db = await getDb();
  await db.delete("referencePills", id);
}

// ── Medications & doses ───────────────────────────────────────────────────
// A medication is every schedule entry with the same name + NDC (one entry
// per time of day it's taken).

export interface Medication {
  key: string; // drugName|ndc
  drugName: string;
  ndc?: string;
  buckets: TimeOfDay[];
  entries: ScheduleEntry[];
}

const BUCKET_ORDER: TimeOfDay[] = ["morning", "noon", "night"];
const medKey = (drugName: string, ndc?: string) => `${drugName.trim().toLowerCase()}|${ndc || ""}`;

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function getMedications(): Promise<Medication[]> {
  const meds = new Map<string, Medication>();
  for (const e of await getSchedule()) {
    const key = medKey(e.drugName, e.ndc);
    const m = meds.get(key) ?? { key, drugName: e.drugName, ndc: e.ndc, buckets: [], entries: [] };
    m.entries.push(e);
    if (!m.buckets.includes(e.bucket)) m.buckets.push(e.bucket);
    meds.set(key, m);
  }
  return [...meds.values()]
    .map((m) => ({ ...m, buckets: BUCKET_ORDER.filter((b) => m.buckets.includes(b)) }))
    .sort((a, b) => a.drugName.localeCompare(b.drugName));
}

// Sets exactly which times of day a medication is taken (adds it if new;
// an empty list removes it). Existing entries -- and their dose history --
// are kept for times that stay selected.
export async function setMedicationTimes(drugName: string, ndc: string | undefined, buckets: TimeOfDay[]) {
  const db = await getDb();
  const key = medKey(drugName, ndc);
  const existing = (await db.getAll("schedule")).filter((e) => medKey(e.drugName, e.ndc) === key);
  for (const e of existing) {
    if (!buckets.includes(e.bucket)) await db.delete("schedule", e.id);
  }
  for (const b of buckets) {
    if (!existing.some((e) => e.bucket === b)) {
      await db.put("schedule", { id: crypto.randomUUID(), drugName, ndc, bucket: b, createdAt: Date.now() });
    }
  }
}

export async function removeMedication(drugName: string, ndc?: string) {
  await setMedicationTimes(drugName, ndc, []);
}

export async function setDoseStatus(entry: ScheduleEntry, date: string, status: DoseStatus | null) {
  const db = await getDb();
  const id = `${date}|${entry.id}`;
  if (status === null) {
    await db.delete("doses", id);
    return;
  }
  await db.put("doses", {
    id, scheduleId: entry.id, drugName: entry.drugName, date, bucket: entry.bucket, status, at: Date.now(),
  });
}

export async function getDoses(fromDate: string, toDate: string): Promise<DoseRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex("doses", "by-date", IDBKeyRange.bound(fromDate, toDate));
}
