"use client";

import { useState } from "react";
import Scheduler from "@/components/Scheduler";
import SafetyReport from "@/components/SafetyReport";

type View = "schedule" | "safety";

// Reuses the existing Scheduler/SafetyReport components as-is -- they already
// read/write the real schedule (lib/db.ts) and run real Beers-criteria +
// interaction checks (lib/safety.ts) against it. v2's own MainApp never
// actually wired these in (its Schedule/Safety tabs were mocked placeholders
// that ignored this real data), so this is the first place they're live.
export default function CareTab() {
  const [view, setView] = useState<View>("schedule");

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
        <button
          onClick={() => setView("schedule")}
          className={`rounded-lg py-2 text-sm font-semibold transition ${
            view === "schedule" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
          }`}
        >
          ⏰ Schedule
        </button>
        <button
          onClick={() => setView("safety")}
          className={`rounded-lg py-2 text-sm font-semibold transition ${
            view === "safety" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
          }`}
        >
          🛡️ Safety
        </button>
      </div>

      {view === "schedule" ? <Scheduler /> : <SafetyReport />}
    </div>
  );
}
