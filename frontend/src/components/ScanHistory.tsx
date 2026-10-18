"use client";

import { useEffect, useState } from "react";
import { clearScans, deleteScan, getScans, type ScanRecord } from "@/lib/db";

// Every pill scanned on this device, newest first, with the safety and
// interaction check for that medicine at the time of the scan.
export default function ScanHistory() {
  const [scans, setScans] = useState<ScanRecord[] | null>(null);

  useEffect(() => {
    getScans().then(setScans).catch(() => setScans([]));
  }, []);

  if (scans === null) return null;

  return (
    <section className="space-y-3">
      <div className="pt-4 border-t border-slate-200 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Scan history</h2>
          <p className="text-sm text-slate-500">
            Every pill checked or identified on this device, and what the safety check found at the time.
          </p>
        </div>
        {scans.length > 0 && (
          <button
            onClick={async () => {
              if (!confirm("Delete the whole scan history on this device?")) return;
              await clearScans();
              setScans([]);
            }}
            className="shrink-0 text-sm text-slate-500 underline"
          >
            Clear
          </button>
        )}
      </div>

      {scans.length === 0 ? (
        <div className="p-8 text-center border-2 border-dashed border-slate-200 rounded-2xl bg-white text-slate-400">
          No scans yet. Pills you check or identify will be listed here.
        </div>
      ) : (
        scans.map((s) => (
          <ScanCard
            key={s.id}
            scan={s}
            onRemove={async () => {
              await deleteScan(s.id);
              setScans((all) => (all ?? []).filter((x) => x.id !== s.id));
            }}
          />
        ))
      )}
    </section>
  );
}

function outcomeText(s: ScanRecord): { text: string; tone: string } {
  const name = s.drugName ?? "Unknown pill";
  switch (s.outcome) {
    case "yours":
      return {
        text: `✓ Your ${name}${s.confirmedByUser ? " (you confirmed it)" : ""}`,
        tone: "bg-emerald-100 text-emerald-900",
      };
    case "check":
      return { text: `Not confirmed: probably your ${name}`, tone: "bg-amber-100 text-amber-900" };
    case "not-yours":
      return { text: "⚠ Not one of your medicines", tone: "bg-red-100 text-red-900" };
    case "identified":
      return { text: `Identified as ${name}`, tone: "bg-indigo-100 text-indigo-900" };
  }
}

function ScanCard({ scan, onRemove }: { scan: ScanRecord; onRemove: () => void }) {
  const o = outcomeText(scan);
  const sf = scan.safety;
  const flags: string[] = [];
  if (sf) {
    for (const i of sf.interactions) {
      const other = i.drug_a === scan.drugName ? i.drug_b : i.drug_a;
      flags.push(`Interaction with ${other} (${i.severity} risk): ${i.description}`);
    }
    for (const d of sf.duplicates) {
      flags.push(`Same ingredient (${d.ingredient}) as ${d.drugs.filter((x) => x !== scan.drugName).join(", ")}: taking both can mean too much.`);
    }
    if (sf.beers) flags.push(`Caution for older adults (${sf.beers.risk_level} risk): ${sf.beers.rationale} ${sf.beers.recommendation}`);
  }

  return (
    <div className="p-3 bg-white border border-slate-200 rounded-2xl shadow-sm space-y-2">
      <div className="flex gap-3">
        {scan.photoDataUrl ? (
          <img src={scan.photoDataUrl} alt="Scanned pill" className="w-16 h-16 rounded-xl border border-slate-200 object-contain bg-white shrink-0" />
        ) : (
          <div className="w-16 h-16 rounded-xl border border-slate-200 bg-slate-50 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs text-slate-500">
            {new Date(scan.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} ·{" "}
            {scan.source === "check" ? "Check a pill" : "Identify"}
          </p>
          <p className={`mt-1 inline-block px-2 py-0.5 rounded-lg text-sm font-bold break-words ${o.tone}`}>{o.text}</p>
        </div>
      </div>
      {!sf ? (
        <p className="text-sm text-slate-500">{scan.safetyNote ?? "No safety check for this scan."}</p>
      ) : flags.length === 0 ? (
        <p className="text-sm text-emerald-700">✓ Safety check: no problems found with your medicines at the time.</p>
      ) : (
        <ul className="space-y-1 bg-red-50 border border-red-200 rounded-xl p-2.5">
          {flags.map((f) => (
            <li key={f} className="text-sm text-red-900 leading-snug">• {f}</li>
          ))}
        </ul>
      )}
      <button onClick={onRemove} className="text-xs text-slate-400 underline">
        Remove
      </button>
    </div>
  );
}
