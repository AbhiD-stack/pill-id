"use client";

import { useEffect, useState } from "react";
import { getSchedule, ScheduleEntry } from "@/lib/db";
import { buildPdfSummary, buildQrPassportDataUrl } from "@/lib/pdf";

export default function QRPassport() {
  const [schedule, setSchedule] = useState<ScheduleEntry[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const s = await getSchedule();
      setSchedule(s);
      setQrDataUrl(await buildQrPassportDataUrl(s));
    })();
  }, []);

  function downloadPdf() {
    const doc = buildPdfSummary(schedule);
    doc.save("medication-summary.pdf");
  }

  return (
    <div className="p-4 flex flex-col items-center gap-6 max-w-md mx-auto">
      <h1 className="text-senior-lg font-bold text-center">QR Health Passport</h1>
      <p className="text-senior text-center text-slate-500">
        Hand your phone to your doctor — they can scan this directly off the screen. No account, no cloud, no PHI
        transmitted.
      </p>
      {qrDataUrl && (
        <img src={qrDataUrl} alt="QR health passport" className="rounded-2xl border-4 border-slate-300" />
      )}
      <button
        onClick={downloadPdf}
        className="min-h-tap w-full text-senior font-bold bg-blue-600 text-white rounded-2xl border-4 border-blue-800"
      >
        📄 Download PDF Summary
      </button>
    </div>
  );
}
