"use client";

import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import { ScheduleEntry } from "./db";

// Builds a clean, printable/emailable PDF summary — this stays entirely in
// browser memory and is only ever exported via the OS share sheet / print
// dialog, never uploaded anywhere.
export function buildPdfSummary(schedule: ScheduleEntry[]): jsPDF {
  const doc = new jsPDF();
  doc.setFontSize(18);
  doc.text("Medication Schedule Summary", 14, 20);
  doc.setFontSize(10);
  doc.text(`Generated ${new Date().toLocaleString()}`, 14, 27);

  let y = 40;
  const buckets: Array<[string, string]> = [
    ["morning", "Morning"],
    ["noon", "Noon"],
    ["night", "Night"],
  ];
  doc.setFontSize(12);
  for (const [key, label] of buckets) {
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

// Packs the schedule into a compact JSON payload for an on-screen QR code
// that a physician can scan directly off the phone with a clinic webcam.
// No name/DOB/identifiers — only drug names/NDCs and bucket timing.
export async function buildQrPassportDataUrl(schedule: ScheduleEntry[]): Promise<string> {
  const payload = {
    v: 1,
    generated: Date.now(),
    meds: schedule.map((s) => ({ n: s.drugName, ndc: s.ndc || null, b: s.bucket })),
  };
  const json = JSON.stringify(payload);
  return QRCode.toDataURL(json, { errorCorrectionLevel: "M", margin: 2, width: 320 });
}
