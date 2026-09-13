"use client";

import { useState } from "react";
import QRPassport from "@/components/QRPassport";
import type { MasterTokenApi } from "@/lib/masterToken";

type View = "passport" | "export";

// ⚠️ Update these with your real survey URLs before a real pilot session.
const CLINICIAN_SURVEY_URL = "https://forms.gle/qpxr9YVjVv5XBkAi6";
const SENIOR_SURVEY_URL = "https://forms.gle/3yijMVghFHrDpj7w6";

export default function ShareTab({ masterToken }: { masterToken: MasterTokenApi }) {
  const [view, setView] = useState<View>("passport");

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
        <button
          onClick={() => setView("passport")}
          className={`rounded-lg py-2 text-sm font-semibold transition ${
            view === "passport" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
          }`}
        >
          🪪 Passport
        </button>
        <button
          onClick={() => setView("export")}
          className={`rounded-lg py-2 text-sm font-semibold transition ${
            view === "export" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
          }`}
        >
          📤 Export
        </button>
      </div>

      {view === "passport" ? <QRPassport /> : <ExportView masterToken={masterToken} />}
    </div>
  );
}

function ExportView({ masterToken }: { masterToken: MasterTokenApi }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!masterToken.token) return;
    await masterToken.copyToken();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-bold text-slate-900">This session's scan token</h3>
        <p className="mt-0.5 text-xs text-slate-400">
          A compact summary of scans this session (which matches, confidence, and how much you had to zoom/rotate to
          get there) — paste it into a feedback survey if asked.
        </p>
        <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-xs text-slate-500">{masterToken.pillCount} pill(s) scanned this session</span>
        </div>
        <button
          onClick={handleCopy}
          disabled={masterToken.pillCount === 0}
          className={`mt-3 w-full rounded-lg py-2.5 text-sm font-bold transition disabled:opacity-40 ${
            copied ? "bg-emerald-600 text-white" : "bg-slate-900 text-white hover:bg-slate-800"
          }`}
        >
          {copied ? "Copied ✓" : "Copy Token"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <a
          href={CLINICIAN_SURVEY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-sky-400 hover:shadow-md"
        >
          <p className="font-semibold text-slate-900">Clinician Survey</p>
          <p className="mt-1 text-xs text-slate-500">Accuracy reviews and safety feedback.</p>
          <span className="mt-3 inline-block text-xs font-semibold text-sky-600">Open form →</span>
        </a>
        <a
          href={SENIOR_SURVEY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-sky-400 hover:shadow-md"
        >
          <p className="font-semibold text-slate-900">Usability Survey</p>
          <p className="mt-1 text-xs text-slate-500">Readability, contrast, ease of use.</p>
          <span className="mt-3 inline-block text-xs font-semibold text-sky-600">Open form →</span>
        </a>
      </div>

      <button
        onClick={masterToken.resetToken}
        className="w-full rounded-lg bg-slate-100 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200"
      >
        Clear this session's token
      </button>
    </div>
  );
}
