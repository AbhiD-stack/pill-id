"use client";

import { useEffect, useState } from "react";
import ScanTab from "./ScanTab";
import MyPillsTab from "./MyPillsTab";
import CareTab from "./CareTab";
import ShareTab from "./ShareTab";
import SettingsTab from "./SettingsTab";
import Onboarding from "./Onboarding";
import { DisclaimerBanner } from "@/components/Disclaimer";
import { getSettings, saveSettings, DEFAULT_SETTINGS, type V3Settings } from "@/lib/dbV3";
import { useMasterToken } from "@/lib/masterToken";

type Tab = "scan" | "mypills" | "care" | "share" | "settings";

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "scan", label: "Scan", icon: "📷" },
  { key: "mypills", label: "Pills", icon: "💊" },
  { key: "care", label: "Care", icon: "🛡️" },
  { key: "share", label: "Share", icon: "🪪" },
  { key: "settings", label: "Settings", icon: "⚙️" },
];

export default function V3App() {
  const [tab, setTab] = useState<Tab>("scan");
  const [settings, setSettings] = useState<V3Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const masterToken = useMasterToken();

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setShowOnboarding(!s.onboarded);
      setReady(true);
    });
  }, []);

  const finishOnboarding = async () => {
    const next = { ...settings, onboarded: true };
    setSettings(next);
    await saveSettings(next);
    setShowOnboarding(false);
  };

  if (!ready) return null;

  return (
    <div className={`flex min-h-screen flex-col bg-slate-50 pb-24 ${settings.textSize === "large" ? "text-[1.1rem]" : ""}`}>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-5 py-3.5 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">💊</span>
            <span className="font-bold tracking-tight text-slate-900">Pill ID</span>
            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-700">V3</span>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl px-4 pt-4">
        <DisclaimerBanner />
      </div>

      <main className="flex-1 px-4 py-5">
        {tab === "scan" && <ScanTab settings={settings} masterToken={masterToken} />}
        {tab === "mypills" && <MyPillsTab settings={settings} />}
        {tab === "care" && <CareTab />}
        {tab === "share" && <ShareTab masterToken={masterToken} />}
        {tab === "settings" && (
          <SettingsTab settings={settings} onChange={setSettings} onReplayTutorial={() => setShowOnboarding(true)} />
        )}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-30 flex justify-around border-t border-slate-200 bg-white/95 py-2 backdrop-blur">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-1.5 transition ${
              tab === t.key ? "font-semibold text-sky-600" : "text-slate-500"
            }`}
          >
            <span className="text-lg">{t.icon}</span>
            <span className="text-[10px]">{t.label}</span>
          </button>
        ))}
      </nav>

      {showOnboarding && <Onboarding onDone={finishOnboarding} />}
    </div>
  );
}
