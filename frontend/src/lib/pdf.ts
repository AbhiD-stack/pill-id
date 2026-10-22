"use client";

import QRCode from "qrcode";
import type { Medication } from "./db";
import { describePlan } from "./schedule";

// Packs the schedule into a compact JSON payload for an on-screen QR code
// that a physician can scan directly off the phone with a clinic webcam.
// No name/DOB/identifiers — only drug names/NDCs and when they're taken.
export async function buildQrPassportDataUrl(meds: Medication[]): Promise<string> {
  const payload = {
    v: 2,
    generated: Date.now(),
    meds: meds.map((m) => ({ n: m.drugName, ndc: m.ndc || null, when: describePlan(m.plan) })),
  };
  return QRCode.toDataURL(JSON.stringify(payload), { errorCorrectionLevel: "M", margin: 2, width: 320 });
}
