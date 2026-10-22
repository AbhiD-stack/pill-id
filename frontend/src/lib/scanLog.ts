"use client";

import { getMedications, putScan, type ScanRecord, type ScanSafety } from "./db";
import { fullSafetyCheck } from "./safety";

// Every pill scan is kept on this device with the safety/interaction check
// for that medicine at the time of the scan, so the patient, a caregiver or
// a doctor can look back at what was scanned and what the app said.

const THUMB_PX = 160;

function shrink(img: CanvasImageSource, w: number, h: number): string {
  const scale = Math.min(1, THUMB_PX / Math.max(w, h, 1));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8);
}

export function thumbFromCanvas(canvas: HTMLCanvasElement): string {
  return shrink(canvas, canvas.width, canvas.height);
}

export function thumbFromUrl(url: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(shrink(img, img.naturalWidth, img.naturalHeight));
    img.onerror = () => resolve("");
    img.src = url;
  });
}

async function safetyFor(drugName: string | null, outcome: ScanRecord["outcome"]): Promise<Pick<ScanRecord, "safety" | "safetyNote">> {
  if (!drugName) {
    return {
      safety: null,
      safetyNote:
        outcome === "not-yours"
          ? "Not one of your medicines, so there was no medicine to check."
          : "This medicine's name isn't on file, so it couldn't be checked.",
    };
  }
  try {
    const others = (await getMedications()).map((m) => m.drugName);
    const { beers, interactions, duplicates } = await fullSafetyCheck(drugName, others);
    const safety: ScanSafety = {
      beers: beers && {
        category: beers.category, risk_level: beers.risk_level, rationale: beers.rationale, recommendation: beers.recommendation,
      },
      interactions,
      duplicates,
    };
    return { safety };
  } catch (err) {
    console.error("Safety check for the scan log failed (non-fatal):", err);
    return { safety: null, safetyNote: "The safety check couldn't run for this scan." };
  }
}

export type NewScan = Omit<ScanRecord, "id" | "at" | "safety" | "safetyNote">;

export async function saveScan(scan: NewScan): Promise<ScanRecord> {
  const rec: ScanRecord = { ...scan, id: crypto.randomUUID(), at: Date.now(), ...(await safetyFor(scan.drugName, scan.outcome)) };
  await putScan(rec);
  return rec;
}

// The patient changed the answer (picked a medicine, or said it isn't one).
export async function reviseScan(rec: ScanRecord, changes: Partial<NewScan>): Promise<ScanRecord> {
  const next: ScanRecord = { ...rec, ...changes };
  if (next.drugName !== rec.drugName || next.outcome !== rec.outcome) Object.assign(next, await safetyFor(next.drugName, next.outcome));
  await putScan(next);
  return next;
}
