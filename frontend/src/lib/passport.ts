"use client";

import { jsPDF } from "jspdf";
import QRCode from "qrcode";

export type PassportEntry = {
  drugName: string;
  ndc?: string;
  bucket?: string;
};

const BUCKETS: Array<[string, string]> = [
  ["morning", "Morning"],
  ["noon", "Noon"],
  ["night", "Night"],
];

// Builds a printable/emailable PDF summary — stays entirely in browser
// memory and is only ever saved via the OS share sheet / download, never
// uploaded anywhere.
export function buildPdfSummary(schedule: PassportEntry[]): jsPDF {
  const doc = new jsPDF();
  doc.setFontSize(18);
  doc.text("Medication Schedule Summary", 14, 20);
  doc.setFontSize(10);
  doc.text(`Generated ${new Date().toLocaleString()}`, 14, 27);

  let y = 40;
  doc.setFontSize(12);
  for (const [key, label] of BUCKETS) {
    doc.setFont("helvetica", "bold");
    doc.text(label, 14, y);
    y += 7;
    doc.setFont("helvetica", "normal");
    const entries = schedule.filter((s) => s.bucket === key);
    if (entries.length === 0) {
      doc.text("  (none)", 14, y);
      y += 7;
    }
    for (const e of entries) {
      doc.text(`  - ${e.drugName}${e.ndc ? " (NDC " + e.ndc + ")" : ""}`, 14, y);
      y += 7;
    }
    y += 3;
  }
  return doc;
}

// Packs the schedule into a compact JSON payload for an on-screen QR code a
// physician can scan directly off the phone with a clinic webcam. No
// name/DOB/identifiers — only drug names/NDCs and bucket timing, and it
// never leaves the device unless the person holding it chooses to show it.
export async function buildQrDataUrl(schedule: PassportEntry[]): Promise<string> {
  const payload = {
    v: 1,
    generated: Date.now(),
    meds: schedule.map((s) => ({ n: s.drugName, ndc: s.ndc || null, b: s.bucket || null })),
  };
  const json = JSON.stringify(payload);
  return QRCode.toDataURL(json, { errorCorrectionLevel: "M", margin: 2, width: 320 });
}
