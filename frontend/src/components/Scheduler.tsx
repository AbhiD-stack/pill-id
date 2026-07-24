"use client";

import { useEffect, useState } from "react";
import { deleteScheduleEntry, getSchedule, ScheduleEntry, TimeOfDay } from "@/lib/db";
import { vibrate } from "./AudioAlert";

const BUCKETS: { key: TimeOfDay; label: string; classes: string }[] = [
  { key: "morning", label: "🌅 Morning", classes: "bg-bucket-morning" },
  { key: "noon", label: "☀️ Noon", classes: "bg-bucket-noon" },
  { key: "night", label: "🌙 Night", classes: "bg-bucket-night" },
];

export default function Scheduler() {
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);

  async function refresh() {
    setEntries(await getSchedule());
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleDelete(id: string) {
    await deleteScheduleEntry(id);
    vibrate(80);
    refresh();
  }

  return (
    <div className="p-4 flex flex-col gap-6 max-w-md mx-auto">
      <h1 className="text-senior-lg font-bold text-center">My Schedule</h1>
      {BUCKETS.map((b) => {
        const items = entries.filter((e) => e.bucket === b.key);
        return (
          <div key={b.key} className="rounded-2xl border-4 border-slate-300 overflow-hidden">
            <div className={`${b.classes} text-white text-senior font-bold p-3`}>{b.label}</div>
            <div className="p-3 flex flex-col gap-2">
              {items.length === 0 && <p className="text-slate-400 text-senior">No medications yet.</p>}
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex justify-between items-center bg-white border-2 border-slate-200 rounded-xl p-3"
                >
                  <span className="text-senior">{item.drugName}</span>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="min-h-tap px-4 text-senior font-bold text-danger border-2 border-danger rounded-xl"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
