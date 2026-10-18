"use client";

import { openDB, DBSchema, IDBPDatabase } from "idb";
import type { Frequency } from "./schedule";

// Old (before exact times): one entry per medicine per time of day. Only
// read once, to convert to MedicationPlan.
export type TimeOfDay = "morning" | "noon" | "night";
export interface ScheduleEntry {
  id: string; // uuid
  drugName: string;
  ndc?: string;
  bucket: TimeOfDay;
  createdAt: number;
}

// One medicine the patient takes on a schedule (as-needed medicines have
// none): exact times and how often (see schedule.ts).
export interface MedicationPlan {
  key: string; // medKey(drugName, ndc)
  drugName: string;
  ndc?: string;
  plan: Frequency;
  amount?: string; // how much each time, e.g. "1 tablet", "2 capsules", "10 mg"
  createdAt: number;
}

// A medicine the user typed in themselves because it isn't in the FDA list
// (compounded, imported, brand-new, supplements...). Not verified.
export interface CustomDrug {
  id: string;
  name: string;
  imprint?: string;
  color?: string; // FDA color words, comma-separated ("RED,BLUE")
  shape?: string; // FDA shape word
  scoreMarks?: string;
  createdAt: number;
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
  // Embeddings of later scans the app confidently recognized as this pill
  // (most recent last, capped): the reference adapts to the patient's own
  // lighting, surfaces and camera. Setup photos are never replaced.
  learnedEmbeddings?: number[][];
  // [mean, std] of each embedding's similarity to other pills (server-side
  // catalog "crowd"), aligned with embeddings / learnedEmbeddings. Used for
  // normalized scores (see myPills.ts).
  cohort?: number[][];
  learnedCohort?: number[][];
  savedAt: number;
  notes?: string;
}

// One dose of one medicine on one day: taken or skipped. A dose with no
// record is still pending (or missed, once its time passes).
export type DoseStatus = "taken" | "skipped";
export interface DoseRecord {
  id: string; // `${date}|${doseId}`
  doseId: string; // `${medKey}@${HH:MM}`
  drugName: string;
  date: string; // YYYY-MM-DD, local time
  time: string; // HH:MM
  status: DoseStatus;
  at: number;
}

// One pill scan and what the safety checks said about it at the time
// (Check a pill, or Identify). Kept on this device; shown in Safety.
export type ScanOutcome = "yours" | "check" | "not-yours" | "identified";
export interface ScanSafety {
  beers: { category: string; risk_level: string; rationale: string; recommendation: string } | null;
  interactions: { drug_a: string; drug_b: string; severity: string; description: string }[];
  duplicates: { ingredient: string; drugs: string[] }[];
}
export interface ScanRecord {
  id: string;
  at: number;
  source: "check" | "identify";
  outcome: ScanOutcome;
  drugName: string | null; // the medicine it was (or most likely was); null if unknown
  ndc?: string;
  confirmedByUser: boolean; // the patient picked it (vs. the app deciding)
  photoDataUrl: string; // small copy of the scan photo
  safety: ScanSafety | null; // null when there's no medicine to check
  safetyNote?: string; // why there are no safety results
}

interface PillIDDb extends DBSchema {
  schedule: { key: string; value: ScheduleEntry; indexes: { "by-bucket": string } };
  logs: { key: string; value: unknown; indexes: { "by-time": number } };
  referencePills: { key: string; value: ReferencePill };
  doses: { key: string; value: DoseRecord; indexes: { "by-date": string } };
  scans: { key: string; value: ScanRecord; indexes: { "by-time": number } };
  plans: { key: string; value: MedicationPlan };
  customDrugs: { key: string; value: CustomDrug };
}

let dbPromise: Promise<IDBPDatabase<PillIDDb>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<PillIDDb>("pill-id-v2", 5, {
      async upgrade(db, oldVersion, _newVersion, tx) {
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
        if (oldVersion < 4) {
          const scans = db.createObjectStore("scans", { keyPath: "id" });
          scans.createIndex("by-time", "at");
          db.createObjectStore("plans", { keyPath: "key" });
          if (oldVersion >= 1) await migrateToPlans(tx as unknown as MigrationTx);
        }
        if (oldVersion < 5) {
          db.createObjectStore("customDrugs", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
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

export const medKey = (drugName: string, ndc?: string) => `${drugName.trim().toLowerCase()}|${ndc || ""}`;

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type Medication = MedicationPlan;

export async function getMedications(): Promise<Medication[]> {
  const db = await getDb();
  return (await db.getAll("plans")).sort((a, b) => a.drugName.localeCompare(b.drugName));
}

// Sets how and when a medicine is taken (adds it if new); null takes it off
// the schedule (as needed). Dose history is kept.
export async function setMedicationPlan(
  drugName: string,
  ndc: string | undefined,
  plan: Frequency | null,
  amount?: string,
) {
  const db = await getDb();
  const key = medKey(drugName, ndc);
  if (!plan) {
    await db.delete("plans", key);
    return;
  }
  const existing = await db.get("plans", key);
  await db.put("plans", { key, drugName, ndc, plan, amount: amount?.trim() || undefined, createdAt: existing?.createdAt ?? Date.now() });
}

export async function removeMedication(drugName: string, ndc?: string) {
  await setMedicationPlan(drugName, ndc, null);
}

export async function setDoseStatus(
  med: { drugName: string },
  dose: { doseId: string; time: string },
  date: string,
  status: DoseStatus | null,
) {
  const db = await getDb();
  const id = `${date}|${dose.doseId}`;
  if (status === null) {
    await db.delete("doses", id);
    return;
  }
  await db.put("doses", { id, doseId: dose.doseId, drugName: med.drugName, date, time: dose.time, status, at: Date.now() });
}

export async function getDoses(fromDate: string, toDate: string): Promise<DoseRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex("doses", "by-date", IDBKeyRange.bound(fromDate, toDate));
}

// Morning / midday / evening entries become a daily plan at the clock times
// the user had set for them; their dose history moves along.
type MigrationTx = {
  objectStore(name: string): { getAll(): Promise<any[]>; put(v: any): Promise<unknown>; delete(k: string): Promise<unknown> };
};
async function migrateToPlans(tx: MigrationTx) {
  const slotTimes: Record<string, string> = { morning: "08:00", noon: "13:00", night: "20:00" };
  try {
    const saved = JSON.parse(localStorage.getItem("pillid.slotTimes") || "{}");
    for (const k of Object.keys(slotTimes)) if (/^\d{2}:\d{2}$/.test(saved[k] ?? "")) slotTimes[k] = saved[k];
  } catch {
    // defaults
  }
  const entries: ScheduleEntry[] = await tx.objectStore("schedule").getAll();
  const plans = new Map<string, MedicationPlan>();
  const doseIdOf = new Map<string, { doseId: string; time: string }>();
  for (const e of entries) {
    const key = medKey(e.drugName, e.ndc);
    const time = slotTimes[e.bucket] ?? "08:00";
    const p = plans.get(key) ?? { key, drugName: e.drugName, ndc: e.ndc, plan: { kind: "daily", times: [] }, createdAt: e.createdAt };
    if (p.plan.kind === "daily" && !p.plan.times.includes(time)) p.plan.times.push(time);
    p.createdAt = Math.min(p.createdAt, e.createdAt);
    plans.set(key, p);
    doseIdOf.set(e.id, { doseId: `${key}@${time}`, time });
  }
  for (const p of plans.values()) {
    if (p.plan.kind === "daily") p.plan.times.sort();
    await tx.objectStore("plans").put(p);
  }
  const doses = tx.objectStore("doses");
  for (const d of await doses.getAll()) {
    const to = doseIdOf.get(d.scheduleId);
    await doses.delete(d.id);
    if (to) await doses.put({ id: `${d.date}|${to.doseId}`, doseId: to.doseId, drugName: d.drugName, date: d.date, time: to.time, status: d.status, at: d.at });
  }
}

// ── Scan history ──────────────────────────────────────────────────────────
const MAX_SCANS = 500;

export async function putScan(scan: ScanRecord) {
  const db = await getDb();
  await db.put("scans", scan);
  const keys = await db.getAllKeysFromIndex("scans", "by-time");
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SCANS))) await db.delete("scans", k);
}

export async function getScans(): Promise<ScanRecord[]> {
  const db = await getDb();
  return (await db.getAll("scans")).sort((a, b) => b.at - a.at);
}

export async function deleteScan(id: string) {
  const db = await getDb();
  await db.delete("scans", id);
}

export async function clearScans() {
  const db = await getDb();
  await db.clear("scans");
}

// ── Medicines the user added themselves ───────────────────────────────────
export async function addCustomDrug(d: Omit<CustomDrug, "id" | "createdAt">): Promise<CustomDrug> {
  const db = await getDb();
  const full: CustomDrug = { ...d, id: crypto.randomUUID(), createdAt: Date.now() };
  await db.put("customDrugs", full);
  return full;
}

export async function getCustomDrugs(): Promise<CustomDrug[]> {
  const db = await getDb();
  return db.getAll("customDrugs");
}
