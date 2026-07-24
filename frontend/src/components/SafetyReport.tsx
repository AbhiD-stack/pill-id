"use client";

import { useEffect, useState } from "react";
import { checkBeersCriteria, checkInteractions, BeersFlag, InteractionFlag } from "@/lib/safety";

export type SafetyCheckItem = {
  id: string;
  drugName: string;
};

type Row = {
  item: SafetyCheckItem;
  beers: BeersFlag | null;
  interactions: InteractionFlag[];
};

// Cross-checks the pills currently on the schedule against each other —
// entirely in-memory, driven by props from MainApp's session state (no
// IndexedDB / persistence).
export default function SafetyReport({ items }: { items: SafetyCheckItem[] }) {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const names = items.map((s) => s.drugName);
      const built: Row[] = await Promise.all(
        items.map(async (item) => {
          const others = names.filter((n) => n !== item.drugName);
          const [beers, interactions] = await Promise.all([
            checkBeersCriteria(item.drugName),
            checkInteractions(item.drugName, others),
          ]);
          return { item, beers, interactions };
        })
      );
      if (!cancelled) setRows(built);
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  if (items.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-slate-400 border-2 border-dashed border-slate-200 rounded-2xl bg-white">
        Nothing scheduled yet — scan and schedule a pill first to see personalized safety flags.
      </p>
    );
  }

  if (!rows) return <p className="p-4 text-center text-sm text-slate-500">Checking scheduled medications...</p>;

  const flaggedCount = rows.filter((r) => r.beers || r.interactions.length > 0).length;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-500 text-center">
        {rows.length} medication{rows.length === 1 ? "" : "s"} on schedule · {flaggedCount} flagged
      </p>

      {rows.map((r) => (
        <div
          key={r.item.id}
          className={`rounded-2xl border-2 p-4 shadow-sm ${
            r.beers || r.interactions.length > 0 ? "border-red-300 bg-red-50" : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <p className="font-bold text-slate-900">{r.item.drugName}</p>
          {r.beers && (
            <p className="text-sm text-red-800 mt-2">
              Beers Criteria ({r.beers.risk_level}): {r.beers.rationale} {r.beers.recommendation}
            </p>
          )}
          {r.interactions.map((i, idx) => (
            <p key={idx} className="text-sm text-red-800 mt-2">
              Interaction with {i.drug_a.toLowerCase() === r.item.drugName.toLowerCase() ? i.drug_b : i.drug_a} (
              {i.severity}): {i.description}
            </p>
          ))}
          {!r.beers && r.interactions.length === 0 && (
            <p className="text-sm text-emerald-700 mt-2">No flags found in local safety database.</p>
          )}
        </div>
      ))}
    </div>
  );
}
