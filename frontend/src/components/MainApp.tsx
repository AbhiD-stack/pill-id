"use client";

import React, { useState, useEffect, useCallback } from "react";
import WelcomeNotice from "./WelcomeNotice";
import Scanner from "@/components/Scanner";
import PillSearchPanel from "@/components/PillSearchPanel";
import TodayView from "@/components/TodayView";
import CheckPill from "@/components/CheckPill";
import AddMedicine from "@/components/AddMedicine";
import MyMedicines from "@/components/MyMedicines";
import ScanHistory from "@/components/ScanHistory";
import { useReminders } from "@/components/useReminders";
import { speak } from "@/components/AudioAlert";
import {
  getReferencePills, updateReferencePill, ReferencePill, getMedications, Medication,
} from "@/lib/db";
import { embedPhoto } from "@/lib/api";
import {
  checkBeersCriteria, checkInteractionsAmong, checkDuplicateIngredients, BeersFlag, InteractionFlag,
  DuplicateIngredient,
} from "@/lib/safety";
import { buildQrPassportDataUrl } from "@/lib/pdf";

// Large-text mode: scales every rem-based size in the app.
const TEXT_KEY = "pillid.largeText";
function readLargeText(): boolean {
  try {
    return localStorage.getItem(TEXT_KEY) === "1";
  } catch {
    return false;
  }
}

type TabType = "check" | "schedule" | "meds" | "identify" | "safety" | "export";
type Adding = { front: HTMLCanvasElement | null; back: HTMLCanvasElement | null } | null;

interface MainAppProps {
  onResetSession: () => void;
}

export default function MainApp({ onResetSession }: MainAppProps) {
  const [activeTab, setActiveTab] = useState<TabType>("meds");
  const [adding, setAdding] = useState<Adding>(null);
  const [identifyMode, setIdentifyMode] = useState<"scan" | "name">("scan");
  const [meds, setMeds] = useState<Medication[]>([]);
  const [beersFlags, setBeersFlags] = useState<{ med: Medication; flag: BeersFlag }[]>([]);
  const [interactionFlags, setInteractionFlags] = useState<InteractionFlag[]>([]);
  const [duplicateFlags, setDuplicateFlags] = useState<DuplicateIngredient[]>([]);
  const [largeText, setLargeText] = useState(false);
  const [medsVersion, setMedsVersion] = useState(0);
  const reminders = useReminders(medsVersion);
  const onMedsChanged = useCallback(() => setMedsVersion((v) => v + 1), []);

  useEffect(() => {
    setLargeText(readLargeText());
    // Open on Today once medicines are set up; until then, on setup.
    Promise.all([getMedications(), getReferencePills()]).then(([m, p]) => {
      if (m.length > 0) setActiveTab("schedule");
      else if (p.length > 0) setActiveTab("check");
    });
  }, []);

  useEffect(() => {
    document.documentElement.style.fontSize = largeText ? "125%" : "";
    try { localStorage.setItem(TEXT_KEY, largeText ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [largeText]);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [referencePills, setReferencePills] = useState<ReferencePill[]>([]);

  // The real medication list lives in IndexedDB (written by Scanner when a
  // match is dropped into a time bucket) -- refresh from it whenever a tab
  // that displays it becomes active, so drops made in the Scan tab show up.
  useEffect(() => {
    if (activeTab === "schedule" || activeTab === "safety" || activeTab === "meds") {
      getMedications().then(setMeds);
    }
    if (activeTab === "meds") {
      getReferencePills().then(setReferencePills);
    }
  }, [activeTab, medsVersion]);

  // Pills saved before scans returned embeddings can't be matched yet --
  // fetch their embeddings once (best-effort; retried next time the tab
  // opens if the backend is unreachable).
  useEffect(() => {
    if (activeTab !== "meds") return;
    const missing = referencePills.filter((r) => !r.embeddings || r.embeddings.length === 0);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      let changed = false;
      for (const pill of missing) {
        try {
          const embeddings = await embedPhoto(pill.photoDataUrl);
          if (embeddings.length === 0) continue;
          await updateReferencePill({ ...pill, embeddings });
          changed = true;
        } catch (err) {
          console.error("Could not prepare saved pill for matching:", err);
          break;
        }
      }
      if (changed && !cancelled) getReferencePills().then(setReferencePills);
    })();
    return () => { cancelled = true; };
  }, [activeTab, referencePills]);

  // Beers Criteria, drug-drug interactions and duplicate ingredients across
  // all of the user's medicines.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const beers: { med: Medication; flag: BeersFlag }[] = [];
      for (const med of meds) {
        const flag = await checkBeersCriteria(med.drugName);
        if (flag) beers.push({ med, flag });
      }
      const names = meds.map((m) => m.drugName);
      if (!cancelled) {
        setBeersFlags(beers);
        setInteractionFlags(checkInteractionsAmong(names));
        setDuplicateFlags(checkDuplicateIngredients(names));
      }
    })();
    return () => { cancelled = true; };
  }, [meds]);

  // Medication passport QR: encodes the real schedule as JSON directly in
  // the code (no name/DOB, no server round-trip) so a phone/clinic webcam
  // can scan it and read the medication list straight off the image.
  useEffect(() => {
    if (meds.length === 0) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    buildQrPassportDataUrl(meds)
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [meds]);

  return (
    <div className="flex-1 flex flex-col pb-28 bg-slate-50 text-slate-900 min-h-screen">
      <WelcomeNotice />
      {/* Top Header */}
      <header className="px-6 py-4 bg-white border-b border-slate-200 flex justify-between items-center sticky top-0 z-40 shadow-sm">
        <div className="flex items-center space-x-3">
          <span className="text-2xl">💊</span>
          <div>
            <h1 className="font-bold text-lg text-slate-900 tracking-tight">Pill ID</h1>
            <p className="text-xs text-slate-500">Medicine manager &amp; pill scanner</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLargeText((v) => !v)}
            aria-pressed={largeText}
            className={`px-3 py-2 rounded-xl text-sm font-bold border ${largeText ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-700 border-slate-300"}`}
            title="Larger text"
          >
            A<span className="text-lg">A</span>
          </button>
        </div>
      </header>

      {reminders.due && activeTab !== "schedule" && (
        <div className={`mx-4 mt-4 p-4 rounded-2xl border-2 shadow-sm ${reminders.due.overdue ? "bg-red-50 border-red-400" : "bg-amber-50 border-amber-400"}`}>
          <p className="text-lg font-bold text-slate-900">
            🔔 {reminders.due.overdue ? `Missed: your ${reminders.due.label} medicines` : `Time for your ${reminders.due.label} medicines`}
          </p>
          <p className="text-base text-slate-700 mt-1">{reminders.due.meds.join(", ")}</p>
          <div className="grid grid-cols-3 gap-2 mt-3">
            <button onClick={() => setActiveTab("schedule")} className="col-span-2 py-3 bg-indigo-600 text-white font-bold rounded-xl">
              Open Today
            </button>
            <button onClick={reminders.dismiss} className="py-3 bg-white border border-slate-300 font-bold rounded-xl">
              Later
            </button>
          </div>
          <button
            onClick={() => speak(`Time for your ${reminders.due!.label} medicines: ${reminders.due!.meds.join(", ")}`)}
            className="mt-2 text-sm text-indigo-700 underline"
          >
            🔊 Read aloud
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col p-6 max-w-3xl mx-auto w-full">
        {activeTab === "check" && (
          <CheckPill
            onSetup={() => { setActiveTab("meds"); setAdding({ front: null, back: null }); }}
            onAddNew={(front, back) => { setActiveTab("meds"); setAdding({ front, back }); }}
            onIdentify={() => { setIdentifyMode("scan"); setActiveTab("identify"); }}
          />
        )}

        {activeTab === "identify" && (
          <div className="flex flex-col flex-1 space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">Identify a pill</h2>
              <p className="text-base text-slate-600">For a pill that isn&apos;t one of your medicines.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["scan", "name"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setIdentifyMode(m)}
                  aria-pressed={identifyMode === m}
                  className={`py-3 rounded-xl border-2 text-base font-bold ${identifyMode === m ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-slate-300 text-slate-700"}`}
                >
                  {m === "scan" ? "📷 From a photo" : "⌨️ By name"}
                </button>
              ))}
            </div>
            {identifyMode === "scan" ? <Scanner /> : <PillSearchPanel addToMeds onAdded={onMedsChanged} />}
          </div>
        )}

        {activeTab === "schedule" && (
          <div className="space-y-4">
            {reminders.permission === "default" && (
              <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-2xl flex items-center justify-between gap-3">
                <p className="text-sm text-indigo-900">Get a notification on this device when it&apos;s time for your medicines.</p>
                <button onClick={reminders.enableNotifications} className="shrink-0 px-4 py-2.5 bg-indigo-600 text-white font-bold rounded-xl text-sm">
                  🔔 Turn on
                </button>
              </div>
            )}
            <TodayView
              onScan={() => { setActiveTab("meds"); setAdding({ front: null, back: null }); }}
              onManage={() => setActiveTab("meds")}
              onChanged={onMedsChanged}
            />
          </div>
        )}

        {activeTab === "safety" && (
          <div className="flex flex-col space-y-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Safety & Interaction Check</h2>
              <p className="text-sm text-slate-500">
                Your medicines are checked against each other for dangerous interactions and duplicate ingredients,
                and against cautions for older adults (AGS Beers Criteria®).
              </p>
            </div>

            {meds.length === 0 ? (
              <div className="p-12 text-center border-2 border-dashed border-slate-200 rounded-2xl bg-white shadow-sm text-slate-400">
                No medicines added yet. Add them on the My meds tab.
              </div>
            ) : beersFlags.length === 0 && interactionFlags.length === 0 && duplicateFlags.length === 0 ? (
              <div className="p-5 bg-emerald-50 border border-emerald-200 rounded-2xl shadow-sm">
                <h3 className="font-semibold text-emerald-800 mb-1">No problems found</h3>
                <p className="text-xs text-emerald-700">
                  None of your {meds.length} medicine{meds.length === 1 ? "" : "s"} matched our interaction,
                  duplicate-ingredient or older-adult caution checks. These checks cover the most important known
                  problems, not every possible one, so still review your list with your pharmacist.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {duplicateFlags.map((d) => (
                  <div key={`dup-${d.ingredient}`} className="p-4 bg-red-50 border border-red-300 rounded-xl shadow-sm">
                    <div className="flex justify-between items-start gap-3">
                      <h3 className="font-semibold text-red-900 capitalize">Same ingredient twice: {d.ingredient}</h3>
                      <span className="shrink-0 text-xs bg-red-200 text-red-900 px-2.5 py-1 rounded-full font-semibold">check dose</span>
                    </div>
                    <p className="text-xs text-red-800 mt-2">
                      {d.drugs.join(" and ")} both contain {d.ingredient}. Taking them together can add up to too
                      much. Ask your pharmacist whether you should take both.
                    </p>
                  </div>
                ))}
                {beersFlags.map(({ med, flag }) => (
                  <div key={med.key} className="p-4 bg-amber-50 border border-amber-300 rounded-xl shadow-sm">
                    <div className="flex justify-between items-start gap-3">
                      <div>
                        <h3 className="font-semibold text-amber-900">{med.drugName}</h3>
                        <p className="text-xs text-amber-700 mt-0.5">{flag.category}</p>
                      </div>
                      <span className="shrink-0 text-xs bg-amber-200 text-amber-900 px-2.5 py-1 rounded-full font-semibold capitalize">
                        {flag.risk_level} risk
                      </span>
                    </div>
                    <p className="text-xs text-amber-800 mt-2">{flag.rationale}</p>
                    <p className="text-xs text-amber-900 mt-1 font-medium">{flag.recommendation}</p>
                  </div>
                ))}
                {interactionFlags.map((f, i) => (
                  <div key={`int-${i}`} className="p-4 bg-red-50 border border-red-300 rounded-xl shadow-sm">
                    <div className="flex justify-between items-start gap-3">
                      <h3 className="font-semibold text-red-900">{f.drug_a} + {f.drug_b}</h3>
                      <span className="shrink-0 text-xs bg-red-200 text-red-900 px-2.5 py-1 rounded-full font-semibold capitalize">
                        {f.severity} risk
                      </span>
                    </div>
                    <p className="text-xs text-red-800 mt-2">{f.description}</p>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[11px] text-slate-400">
              These checks don&apos;t account for dose, duration, diagnosis or allergies, and are not a substitute for
              pharmacist or clinician review.
            </p>

            <ScanHistory />
          </div>
        )}

        {activeTab === "meds" && adding && (
          <AddMedicine
            initialFront={adding.front}
            initialBack={adding.back}
            onFinished={() => { setAdding(null); onMedsChanged(); }}
            onCancel={() => setAdding(null)}
          />
        )}

        {activeTab === "meds" && !adding && (
          <div className="flex flex-col space-y-6">
            <MyMedicines onAdd={() => setAdding({ front: null, back: null })} onChanged={onMedsChanged} />
            <div className="pt-4 border-t border-slate-200">
              <h2 className="text-xl font-bold text-slate-900">Medication Passport</h2>
              <p className="text-sm text-slate-500">Portable emergency summary profile.</p>
            </div>
            <div className="p-8 bg-white border border-slate-200 rounded-2xl shadow-sm flex flex-col items-center text-center">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="QR code encoding your medication schedule"
                  className="w-40 h-40 rounded-2xl border border-slate-300 mb-4"
                />
              ) : (
                <div className="w-40 h-40 bg-slate-100 border border-slate-300 p-3 rounded-2xl mb-4 flex flex-col items-center justify-center text-slate-400 font-semibold text-xs shadow-inner">
                  <span className="text-3xl mb-1">🪪</span>
                  Scan a pill first
                </div>
              )}
              <p className="text-xs text-slate-500 max-w-sm">
                {qrDataUrl
                  ? `Encodes your ${meds.length} scheduled medication${meds.length === 1 ? "" : "s"} (name, NDC, how often and when) directly in the code — generated on this device, nothing sent to a server. Scan it to load the list elsewhere.`
                  : "Scan this passport code to load the medication list instantly, with no server-side data persistence."}
              </p>
            </div>

          </div>
        )}

        {activeTab === "export" && (
          <div className="flex flex-col space-y-6">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Evaluation Surveys</h2>
              <p className="text-sm text-slate-500">Share feedback on the app, straight to the team.</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <a
                href="https://docs.google.com/forms/d/e/1FAIpQLSeg2oF4e34Qjnll80ngD_qhlnIhgHmLxmFEE2pBrgIRs6GMqg/viewform?usp=dialog"
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
                href="https://docs.google.com/forms/d/e/1FAIpQLSf_tivF3x5qIdl5-N5j58kuSOyG4Sv1DDUbPoXhkmwRPrg2cA/viewform?usp=dialog"
                target="_blank"
                rel="noopener noreferrer"
                className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm hover:border-blue-400 hover:shadow-md transition flex flex-col justify-between"
              >
                <div>
                  <h4 className="font-semibold text-slate-900 mb-1">Physician Survey</h4>
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
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-t border-slate-200 px-1 py-2 flex justify-around items-center shadow-lg">
        <button
          onClick={() => { setActiveTab("check"); setAdding(null); }}
          aria-current={activeTab === "check" ? "page" : undefined}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "check" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">📷</span>
          <span className="text-[11px] mt-0.5">Check pill</span>
        </button>
        <button
          onClick={() => { setActiveTab("schedule"); setAdding(null); }}
          aria-current={activeTab === "schedule" ? "page" : undefined}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "schedule" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">✅</span>
          <span className="text-[11px] mt-0.5">Today</span>
        </button>
        <button
          onClick={() => { setActiveTab("meds"); setAdding(null); }}
          aria-current={activeTab === "meds" ? "page" : undefined}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "meds" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">💊</span>
          <span className="text-[11px] mt-0.5">My meds</span>
        </button>
        <button
          onClick={() => { setActiveTab("identify"); setAdding(null); }}
          aria-current={activeTab === "identify" ? "page" : undefined}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "identify" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">🔍</span>
          <span className="text-[11px] mt-0.5">Identify</span>
        </button>
        <button
          onClick={() => { setActiveTab("safety"); setAdding(null); }}
          aria-current={activeTab === "safety" ? "page" : undefined}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "safety" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">🛡️</span>
          <span className="text-[11px] mt-0.5">Safety</span>
        </button>
        <button
          onClick={() => { setActiveTab("export"); setAdding(null); }}
          aria-current={activeTab === "export" ? "page" : undefined}
          className={`flex flex-col items-center flex-1 py-1.5 transition ${activeTab === "export" ? "text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-800"}`}
        >
          <span className="text-xl">📤</span>
          <span className="text-[11px] mt-0.5">Survey</span>
        </button>
      </nav>
    </div>
  );
}
