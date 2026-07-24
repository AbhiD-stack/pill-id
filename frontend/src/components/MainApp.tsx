"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import Scanner, { type IdentificationResult, type ScheduledPill, type TimeOfDay } from "@/components/Scanner";
import SafetyReport, { type SafetyCheckItem } from "@/components/SafetyReport";
import { useMasterToken } from "@/lib/masterToken";
import { listBeersCriteria, type BeersFlag } from "@/lib/safety";
import { buildPdfSummary, buildQrDataUrl } from "@/lib/passport";

type TabType = "scan" | "schedule" | "safety" | "passport" | "export";

export type PillEntry = {
  id: string;
  drug_name?: string;
  ndc?: string;
  score: number;
  timestamp: number;
  scheduleTime?: string;
  notes?: string;
};

interface MainAppProps {
  onResetSession: () => void;
}

const BUCKET_META: Record<TimeOfDay, { label: string; time: string; icon: string; classes: string }> = {
  morning: { label: "Morning", time: "5am – 11am", icon: "🌅", classes: "bg-amber-500" },
  noon: { label: "Midday", time: "11am – 4pm", icon: "☀️", classes: "bg-cyan-500" },
  night: { label: "Evening", time: "6pm – 11pm", icon: "🌙", classes: "bg-indigo-600" },
};

const NAV_ITEMS: { key: TabType; label: string; icon: string }[] = [
  { key: "scan", label: "Scan", icon: "📷" },
  { key: "schedule", label: "Schedule", icon: "⏰" },
  { key: "safety", label: "Safety", icon: "🛡️" },
  { key: "passport", label: "Passport", icon: "🪪" },
  { key: "export", label: "Export", icon: "📤" },
];

export default function MainApp({ onResetSession }: MainAppProps) {
  const [activeTab, setActiveTab] = useState<TabType>("scan");
  const [savedPills, setSavedPills] = useState<PillEntry[]>([]);
  const [beersList, setBeersList] = useState<BeersFlag[] | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Real master token — pill names, confidences, rotation/crop adjustments,
  // and latency per scan (same format v1 uses), fed live by Scanner.
  const master = useMasterToken();

  useEffect(() => {
    if (activeTab === "safety" && !beersList) {
      listBeersCriteria()
        .then(setBeersList)
        .catch(() => setBeersList([]));
    }
  }, [activeTab, beersList]);

  useEffect(() => {
    if (activeTab !== "passport" || savedPills.length === 0) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    buildQrDataUrl(savedPills.map((p) => ({ drugName: p.drug_name || "Unknown", ndc: p.ndc, bucket: p.scheduleTime })))
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, savedPills]);

  const handleAddPill = (pill: Omit<PillEntry, "id" | "timestamp">) => {
    const newEntry: PillEntry = {
      ...pill,
      id: Math.random().toString(36).substring(2, 9),
      timestamp: Date.now(),
    };
    setSavedPills((prev) => [newEntry, ...prev]);
  };

  const handleIdentified = (result: IdentificationResult) => {
    master.addIdentification(result.drug_names, result.confidences, result.rotation, result.adjustments, result.latency_ms);
  };

  const handleScheduled = (pill: ScheduledPill) => {
    handleAddPill({
      drug_name: pill.drug_name,
      ndc: pill.ndc ?? undefined,
      score: pill.score,
      scheduleTime: pill.bucket,
    });
  };

  const handleDownloadPdf = () => {
    const doc = buildPdfSummary(
      savedPills.map((p) => ({ drugName: p.drug_name || "Unknown", ndc: p.ndc, bucket: p.scheduleTime }))
    );
    doc.save("medication-summary.pdf");
  };

  // In-memory only — no IndexedDB / persistence. Cleared on refresh.
  const existingDrugNames = savedPills.map((p) => p.drug_name).filter((n): n is string => !!n);
  const safetyItems: SafetyCheckItem[] = savedPills
    .filter((p) => p.drug_name)
    .map((p) => ({ id: p.id, drugName: p.drug_name! }));

  return (
    <div className="flex-1 flex flex-col pb-28 bg-slate-50 text-slate-900 min-h-screen">
      {/* Top Header */}
      <header className="px-6 py-4 bg-white border-b border-slate-200 flex justify-between items-center sticky top-0 z-40 shadow-sm">
        <div className="flex items-center space-x-3">
          <Link
            href="/"
            className="flex items-center justify-center w-10 h-10 rounded-full bg-slate-100 text-slate-600 hover:bg-blue-100 hover:text-blue-700 hover:scale-105 transition-all"
            title="Back to home"
            aria-label="Back to home"
          >
            ←
          </Link>
          <span className="text-2xl">💊</span>
          <div>
            <h1 className="font-bold text-lg text-slate-900 tracking-tight">
              Geriatric Medication Safety & Pill ID
            </h1>
            <p className="text-xs text-slate-500">Evaluation Portal</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-3 py-1 rounded-full font-medium shadow-sm">
            System Active
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col p-6 max-w-3xl mx-auto w-full">
        {activeTab === "scan" && (
          <div className="flex flex-col flex-1">
            <Scanner
              existingDrugNames={existingDrugNames}
              onIdentified={handleIdentified}
              onScheduled={handleScheduled}
            />
          </div>
        )}

        {activeTab === "schedule" && (
          <div className="flex flex-col space-y-5">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Medication Schedule</h2>
              <p className="text-sm text-slate-500">Manage daily dosage times and prevent missed medications.</p>
            </div>
            {savedPills.length === 0 ? (
              <div className="p-12 text-center border-2 border-dashed border-slate-200 rounded-3xl bg-white shadow-sm text-slate-400">
                No pills scanned yet. Go to the Scan tab to analyze and add medications.
              </div>
            ) : (
              (Object.keys(BUCKET_META) as TimeOfDay[]).map((bucket) => {
                const pills = savedPills.filter((p) => p.scheduleTime === bucket);
                const meta = BUCKET_META[bucket];
                return (
                  <div key={bucket} className="rounded-3xl border-2 border-slate-200 bg-white shadow-sm overflow-hidden">
                    <div className={`${meta.classes} px-5 py-3 flex items-center gap-3 text-white`}>
                      <span className="text-2xl">{meta.icon}</span>
                      <div>
                        <p className="font-black text-lg leading-tight">{meta.label}</p>
                        <p className="text-xs text-white/90">{meta.time}</p>
                      </div>
                      <span className="ml-auto text-xs font-bold bg-white/20 px-3 py-1 rounded-full">
                        {pills.length} pill{pills.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="p-4 space-y-2">
                      {pills.length === 0 ? (
                        <p className="text-sm text-slate-400 text-center py-3">Nothing scheduled here yet.</p>
                      ) : (
                        pills.map((pill) => (
                          <div
                            key={pill.id}
                            className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex justify-between items-center"
                          >
                            <div>
                              <h3 className="font-semibold text-slate-800">{pill.drug_name || "Unknown Pill"}</h3>
                              <p className="text-xs text-slate-500">
                                NDC: {pill.ndc || "N/A"} • Score: {(pill.score * 100).toFixed(1)}%
                              </p>
                            </div>
                            <span className="text-xs bg-blue-50 text-blue-700 px-3 py-1 rounded-lg border border-blue-200 font-medium">
                              Active
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === "safety" && (
          <div className="flex flex-col space-y-5">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Safety & Interaction Check</h2>
              <p className="text-sm text-slate-500">Review potential drug-drug interactions and Beers Criteria warnings.</p>
            </div>

            <div className="p-5 bg-blue-50 border border-blue-200 rounded-2xl shadow-sm space-y-2">
              <h3 className="font-semibold text-blue-900 text-sm">What this checks</h3>
              <p className="text-xs text-blue-800 leading-relaxed">
                Every pill you add to your schedule is cross-checked against the American Geriatrics Society
                Beers Criteria® (medications considered potentially inappropriate for older adults) and a
                curated list of high-priority drug-drug interactions. This is a decision-support aid, not a
                substitute for clinical judgment — always confirm with a pharmacist or physician.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-slate-800 text-sm mb-2">Your Schedule</h3>
              <SafetyReport items={safetyItems} />
            </div>

            <div>
              <h3 className="font-semibold text-slate-800 text-sm mb-2">Beers Criteria Reference</h3>
              {!beersList ? (
                <p className="text-sm text-slate-400 text-center py-4">Loading reference table...</p>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-50 text-slate-500 uppercase tracking-wide">
                      <tr>
                        <th className="px-3 py-2">Drug</th>
                        <th className="px-3 py-2">Category</th>
                        <th className="px-3 py-2">Risk</th>
                        <th className="px-3 py-2">Rationale</th>
                      </tr>
                    </thead>
                    <tbody>
                      {beersList.map((b, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-3 py-2 font-medium text-slate-800">{b.drug_name}</td>
                          <td className="px-3 py-2 text-slate-500">{b.category}</td>
                          <td
                            className={`px-3 py-2 font-semibold ${
                              b.risk_level === "high"
                                ? "text-red-600"
                                : b.risk_level === "moderate"
                                  ? "text-amber-600"
                                  : "text-emerald-600"
                            }`}
                          >
                            {b.risk_level}
                          </td>
                          <td className="px-3 py-2 text-slate-500">{b.rationale}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="text-xs text-slate-400 text-center">
              Uses a locally bundled, non-exhaustive sample of Beers Criteria® and ONCHigh interaction data.
            </p>
          </div>
        )}

        {activeTab === "passport" && (
          <div className="flex flex-col space-y-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Medication Passport</h2>
              <p className="text-sm text-slate-500">Portable emergency summary — hand your phone to your doctor.</p>
            </div>
            <div className="p-8 bg-white border-2 border-slate-200 rounded-3xl shadow-sm flex flex-col items-center text-center">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="QR code encoding your medication schedule"
                  className="w-48 h-48 rounded-2xl border-4 border-slate-200 shadow-inner mb-4"
                />
              ) : (
                <div className="w-48 h-48 bg-slate-100 border-4 border-slate-200 rounded-2xl mb-4 flex flex-col items-center justify-center text-slate-400 text-sm p-4">
                  <span className="text-3xl mb-2">🪪</span>
                  Add pills to your schedule to generate a passport QR code.
                </div>
              )}
              <p className="text-xs text-slate-500 max-w-sm">
                Scanning this code shows the drug names, NDCs, and schedule times directly on the scanning
                device — nothing is uploaded, stored, or sent anywhere.
              </p>
              <button
                onClick={handleDownloadPdf}
                disabled={savedPills.length === 0}
                className="mt-6 min-h-tap w-full text-base font-bold bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-2xl border-4 border-blue-800 disabled:border-slate-300 transition"
              >
                📄 Download PDF Summary
              </button>
            </div>
          </div>
        )}

        {activeTab === "export" && (
          <div className="flex flex-col space-y-6">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Telemetry & Performance Surveys</h2>
              <p className="text-sm text-slate-500">Track execution latency, clicks/crops telemetry, and complete evaluation feedback forms.</p>
            </div>

            <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm space-y-3">
              <h3 className="font-semibold text-slate-800 text-sm">Master Token (Pill Names, Confidences & Latency)</h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={master.token || "No pills identified yet — scan a pill first."}
                  className="flex-1 bg-slate-50 border border-slate-200 px-3 py-2 rounded-xl text-sm font-mono text-slate-700"
                />
                <button
                  onClick={() => master.copyToken()}
                  disabled={!master.token}
                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-xs font-semibold rounded-xl transition shadow-sm"
                >
                  Copy Token
                </button>
              </div>
              <p className="text-xs text-slate-400">
                {master.pillCount} pill{master.pillCount === 1 ? "" : "s"} identified this session. Same format as
                v1's pilot batch token: drug names, confidences, rotation/crop adjustments, and latency per scan.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <a
                href="https://forms.gle/qpxr9YVjVv5XBkAi6"
                target="_blank"
                rel="noopener noreferrer"
                className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm hover:border-blue-400 hover:shadow-md transition flex flex-col justify-between"
              >
                <div>
                  <h4 className="font-semibold text-slate-900 mb-1">Clinician Survey</h4>
                  <p className="text-xs text-slate-500">Submit accuracy reviews and safety feedback.</p>
                </div>
                <span className="text-xs font-semibold text-blue-600 mt-4 inline-flex items-center">
                  Open Form →
                </span>
              </a>

              <a
                href="https://forms.gle/3yijMVghFHrDpj7w6"
                target="_blank"
                rel="noopener noreferrer"
                className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm hover:border-blue-400 hover:shadow-md transition flex flex-col justify-between"
              >
                <div>
                  <h4 className="font-semibold text-slate-900 mb-1">Senior Usability Survey</h4>
                  <p className="text-xs text-slate-500">Provide feedback on interface readability, contrast, and ease of use.</p>
                </div>
                <span className="text-xs font-semibold text-blue-600 mt-4 inline-flex items-center">
                  Open Form →
                </span>
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Fixed Mobile Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-t border-slate-200 px-2 py-2 flex justify-around items-center shadow-lg">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setActiveTab(item.key)}
              className={`flex flex-col items-center flex-1 py-2 mx-0.5 rounded-2xl transition-all duration-150 hover:scale-110 hover:shadow-md hover:bg-blue-50 hover:text-blue-600 ${
                isActive ? "bg-blue-50 text-blue-600 font-semibold shadow-inner" : "text-slate-500"
              }`}
            >
              <span className="text-xl">{item.icon}</span>
              <span className="text-[11px] mt-0.5">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
