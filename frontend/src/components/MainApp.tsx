"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import Scanner, { type IdentificationResult, type ScheduledPill } from "@/components/Scanner";
import SafetyReport, { type SafetyCheckItem } from "@/components/SafetyReport";
import { useMasterToken } from "@/lib/masterToken";
import { listBeersCriteria, type BeersFlag } from "@/lib/safety";

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

export default function MainApp({ onResetSession }: MainAppProps) {
  const [activeTab, setActiveTab] = useState<TabType>("scan");
  const [savedPills, setSavedPills] = useState<PillEntry[]>([]);
  const [beersList, setBeersList] = useState<BeersFlag[] | null>(null);

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

  // In-memory only — no IndexedDB / persistence. Cleared on refresh.
  const existingDrugNames = savedPills.map((p) => p.drug_name).filter((n): n is string => !!n);
  const safetyItems: SafetyCheckItem[] = savedPills
    .filter((p) => p.drug_name)
    .map((p) => ({ id: p.id, drugName: p.drug_name! }));

  const navButtonClass = (tab: TabType) =>
    `flex flex-col items-center flex-1 py-1.5 mx-0.5 rounded-xl transition-all duration-150 hover:scale-110 hover:shadow-md hover:bg-blue-50 hover:text-blue-600 ${
      activeTab === tab ? "text-blue-600 font-semibold" : "text-slate-500"
    }`;

  return (
    <div className="flex-1 flex flex-col pb-28 bg-slate-50 text-slate-900 min-h-screen">
      {/* Top Header */}
      <header className="px-6 py-4 bg-white border-b border-slate-200 flex justify-between items-center sticky top-0 z-40 shadow-sm">
        <div className="flex items-center space-x-3">
          <Link
            href="/"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900 transition"
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
          <div className="flex flex-col space-y-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Medication Schedule</h2>
              <p className="text-sm text-slate-500">Manage daily dosage times and prevent missed medications.</p>
            </div>
            {savedPills.length === 0 ? (
              <div className="p-12 text-center border-2 border-dashed border-slate-200 rounded-2xl bg-white shadow-sm text-slate-400">
                No pills scanned yet. Go to the Scan tab to analyze and add medications.
              </div>
            ) : (
              <div className="space-y-3">
                {savedPills.map((pill) => (
                  <div key={pill.id} className="p-4 bg-white border border-slate-200 rounded-xl shadow-sm flex justify-between items-center">
                    <div>
                      <h3 className="font-semibold text-slate-800">{pill.drug_name || "Unknown Pill"}</h3>
                      <p className="text-xs text-slate-500">
                        NDC: {pill.ndc || "N/A"} • Score: {(pill.score * 100).toFixed(1)}%
                        {pill.scheduleTime ? ` • ${pill.scheduleTime}` : ""}
                      </p>
                    </div>
                    <span className="text-xs bg-blue-50 text-blue-700 px-3 py-1 rounded-lg border border-blue-200 font-medium">
                      Active
                    </span>
                  </div>
                ))}
              </div>
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
              <p className="text-sm text-slate-500">Portable emergency summary profile.</p>
            </div>
            <div className="p-8 bg-white border border-slate-200 rounded-2xl shadow-sm flex flex-col items-center text-center">
              <div className="w-40 h-40 bg-slate-100 border border-slate-300 p-3 rounded-2xl mb-4 flex flex-col items-center justify-center text-slate-600 font-semibold text-xs shadow-inner">
                <span className="text-3xl mb-1">🪪</span>
                QR PASSPORT CODE
                <span className="text-[10px] text-slate-400 mt-1 break-all px-2">
                  {master.token || "No pills identified yet"}
                </span>
              </div>
              <p className="text-xs text-slate-500 max-w-sm">
                Scan this passport code to load the temporary profile instantly without server-side data persistence.
              </p>
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
                href="https://forms.gle/placeholder-senior-usability"
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

              <a
                href="https://forms.gle/placeholder-clinical-audit"
                target="_blank"
                rel="noopener noreferrer"
                className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm hover:border-blue-400 hover:shadow-md transition flex flex-col justify-between"
              >
                <div>
                  <h4 className="font-semibold text-slate-900 mb-1">Clinical Audit Survey</h4>
                  <p className="text-xs text-slate-500">Submit accuracy reviews and safety feedback.</p>
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
        <button onClick={() => setActiveTab("scan")} className={navButtonClass("scan")}>
          <span className="text-xl">📷</span>
          <span className="text-[11px] mt-0.5">Scan</span>
        </button>

        <button onClick={() => setActiveTab("schedule")} className={navButtonClass("schedule")}>
          <span className="text-xl">⏰</span>
          <span className="text-[11px] mt-0.5">Schedule</span>
        </button>

        <button onClick={() => setActiveTab("safety")} className={navButtonClass("safety")}>
          <span className="text-xl">🛡️</span>
          <span className="text-[11px] mt-0.5">Safety</span>
        </button>

        <button onClick={() => setActiveTab("passport")} className={navButtonClass("passport")}>
          <span className="text-xl">🪪</span>
          <span className="text-[11px] mt-0.5">Passport</span>
        </button>

        <button onClick={() => setActiveTab("export")} className={navButtonClass("export")}>
          <span className="text-xl">📤</span>
          <span className="text-[11px] mt-0.5">Export</span>
        </button>
      </nav>
    </div>
  );
}
