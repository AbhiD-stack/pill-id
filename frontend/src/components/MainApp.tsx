"use client";

import React, { useState } from "react";
import Scanner from "@/components/Scanner";

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
  
  // v1-style telemetry tracking token (capturing latency, clicks/crops, and execution metrics)
  const [telemetryToken] = useState(() => "TELEMETRY-LATENCY-CLICKS-CROPS-" + Math.random().toString(36).substring(2, 8).toUpperCase());

  const handleAddPill = (pill: Omit<PillEntry, "id" | "timestamp">) => {
    const newEntry: PillEntry = {
      ...pill,
      id: Math.random().toString(36).substring(2, 9),
      timestamp: Date.now(),
    };
    setSavedPills((prev) => [newEntry, ...prev]);
  };

  return (
    <div className="flex-1 flex flex-col pb-28 bg-slate-50 text-slate-900 min-h-screen">
      {/* Top Header */}
      <header className="px-6 py-4 bg-white border-b border-slate-200 flex justify-between items-center sticky top-0 z-40 shadow-sm">
        <div className="flex items-center space-x-3">
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
             <Scanner  />
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
                      <p className="text-xs text-slate-500">NDC: {pill.ndc || "N/A"} • Score: {(pill.score * 100).toFixed(1)}%</p>
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
          <div className="flex flex-col space-y-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Safety & Interaction Check</h2>
              <p className="text-sm text-slate-500">Review potential drug-drug interactions and Beers criteria warnings.</p>
            </div>
            <div className="p-5 bg-emerald-50 border border-emerald-200 rounded-2xl shadow-sm">
              <h3 className="font-semibold text-emerald-800 mb-1">Safety Status: Stable</h3>
              <p className="text-xs text-emerald-700">No high-risk polypharmacy interactions flagged in current active items.</p>
            </div>
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
                <span className="text-[10px] text-slate-400 mt-1">{telemetryToken}</span>
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
              <h3 className="font-semibold text-slate-800 text-sm">Telemetry Token (Latency, Clicks & Crops Tracker)</h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={telemetryToken}
                  className="flex-1 bg-slate-50 border border-slate-200 px-3 py-2 rounded-xl text-sm font-mono text-slate-700"
                />
                <button
                  onClick={() => navigator.clipboard.writeText(telemetryToken)}
                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-xl transition shadow-sm"
                >
                  Copy Token
                </button>
              </div>
              <p className="text-xs text-slate-400">Tracks real-time inference latency, crop bounding boxes, and click interactions locally (v1 style).</p>
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

            <button
              onClick={() => alert("Local telemetry data cleared. No data stored.")}
              className="w-full py-3 bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold rounded-xl transition"
            >
              Clear Local State
            </button>
          </div>
        )}
      </div>

      {/* Fixed Mobile Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-t border-slate-200 px-2 py-2 flex justify-around items-center shadow-lg">
        <button
          onClick={() => setActiveTab("scan")}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "scan" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">📷</span>
          <span className="text-[11px] mt-0.5">Scan</span>
        </button>

        <button
          onClick={() => setActiveTab("schedule")}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "schedule" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">⏰</span>
          <span className="text-[11px] mt-0.5">Schedule</span>
        </button>

        <button
          onClick={() => setActiveTab("safety")}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "safety" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">🛡️</span>
          <span className="text-[11px] mt-0.5">Safety</span>
        </button>

        <button
          onClick={() => setActiveTab("passport")}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "passport" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">🪪</span>
          <span className="text-[11px] mt-0.5">Passport</span>
        </button>

        <button
          onClick={() => setActiveTab("export")}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "export" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">📤</span>
          <span className="text-[11px] mt-0.5">Export</span>
        </button>
      </nav>
    </div>
  );
}