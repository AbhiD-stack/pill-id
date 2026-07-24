"use client";

export type RiskLevel = "high" | "moderate" | "low";

export interface BeersFlag {
  drug_name: string;
  category: string;
  risk_level: RiskLevel;
  rationale: string;
  recommendation: string;
}

export interface InteractionFlag {
  drug_a: string;
  drug_b: string;
  severity: RiskLevel;
  description: string;
}

let beersCache: { flagged_drugs: BeersFlag[] } | null = null;
let interactionsCache: { interactions: InteractionFlag[] } | null = null;

async function loadBeers() {
  if (!beersCache) beersCache = await (await fetch("/data/beers_criteria.json")).json();
  return beersCache!;
}

async function loadInteractions() {
  if (!interactionsCache)
    interactionsCache = await (await fetch("/data/drug_interactions.json")).json();
  return interactionsCache!;
}

function normalize(name: string) {
  return name.trim().toLowerCase();
}

export async function checkBeersCriteria(drugName: string): Promise<BeersFlag | null> {
  const { flagged_drugs } = await loadBeers();
  const n = normalize(drugName);
  return (
    flagged_drugs.find(
      (d: any) => normalize(d.drug_name) === n || (d.aliases || []).some((a: string) => normalize(a) === n)
    ) || null
  );
}

// Cross-joins a newly scanned drug against every drug already in the user's
// schedule / recent log, matching the "safety-check cross-join" described
// in your Physician Day plan.
export async function checkInteractions(
  newDrug: string,
  existingDrugs: string[]
): Promise<InteractionFlag[]> {
  const { interactions } = await loadInteractions();
  const n = normalize(newDrug);
  const existingSet = new Set(existingDrugs.map(normalize));
  return interactions.filter((i) => {
    const a = normalize(i.drug_a);
    const b = normalize(i.drug_b);
    return (a === n && existingSet.has(b)) || (b === n && existingSet.has(a));
  });
}

export async function fullSafetyCheck(newDrug: string, existingDrugs: string[]) {
  const [beers, interactions] = await Promise.all([
    checkBeersCriteria(newDrug),
    checkInteractions(newDrug, existingDrugs),
  ]);
  return { beers, interactions };
}
