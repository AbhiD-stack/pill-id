"use client";

import { useEffect, useState } from "react";
import { getSchedule, ScheduleEntry } from "@/lib/db";
import { checkBeersCriteria, checkInteractions, BeersFlag, InteractionFlag } from "@/lib/safety";

type Row = {
  entry: ScheduleEntry;
  beers: BeersFlag | null;
  interactions: InteractionFlag[];
};

export default function SafetyReport() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    (async () => {
      const schedule = await getSchedule();
      const names = schedule.map((s) => s.drugName);
      const built: Row[] = await Promise.all(
        schedule.map(async (entry) => {
          const others = names.filter((n) => n !== entry.drugName);
          const [beers, interactions] = await Promise.all([
            checkBeersCriteria(entry.drugName),
            checkInteractions(entry.drugName, others),
          ]);
          return { entry, beers, interactions };
        })
      );
      setRows(built);
    })();
  }, []);

  if (!rows) return <p className="p-4 text-senior text-center">Loading safety report...</p>;

  const flaggedCount = rows.filter((r) => r.beers || r.interactions.length > 0).length;

  return (
    <div className="p-4 flex flex-col gap-4 max-w-md mx-auto">
      <h1 className="text-senior-lg font-bold text-center">Safety Report</h1>
      <p className="text-senior text-center text-slate-500">
        {rows.length} medication{rows.length === 1 ? "" : "s"} on schedule · {flaggedCount} flagged
      </p>

      {rows.length === 0 && (
        <p className="text-senior text-center text-slate-400">Nothing scheduled yet — scan and schedule a pill first.</p>
      )}

      {rows.map((r) => (
        <div
          key={r.entry.id}
          className={`rounded-2xl border-4 p-4 ${
            r.beers || r.interactions.length > 0 ? "border-danger bg-red-50" : "border-safe bg-green-50"
          }`}
        >
          <p className="text-senior font-bold">{r.entry.drugName}</p>
          {r.beers && (
            <p className="text-senior text-danger mt-2">
              Beers Criteria ({r.beers.risk_level}): {r.beers.rationale} {r.beers.recommendation}
            </p>
          )}
          {r.interactions.map((i, idx) => (
            <p key={idx} className="text-senior text-danger mt-2">
              Interaction with {i.drug_a === r.entry.drugName.toLowerCase() ? i.drug_b : i.drug_a} ({i.severity}):{" "}
              {i.description}
            </p>
          ))}
          {!r.beers && r.interactions.length === 0 && (
            <p className="text-senior text-safe mt-2">No flags found in local safety database.</p>
          )}
        </div>
      ))}

      <p className="text-xs text-slate-400 text-center mt-4">
        This report uses a locally bundled, non-exhaustive sample of Beers Criteria® and ONCHigh interaction data.
        It is a decision-support aid, not a substitute for clinical judgment.
      </p>
    </div>
  );
}
