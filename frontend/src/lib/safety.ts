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

// Scanned drug names come back from the backend as full RxNorm-style
// strings ("ibuprofen 200 MG Oral Tablet"), not bare generic names, so an
// exact-equality check against a flagged entry's "ibuprofen" would never
// match anything -- the Beers/interaction checks would silently always
// come back clean regardless of what was actually scanned. Match by
// substring instead.
function nameMatches(fullDrugName: string, candidate: string): boolean {
  return normalize(fullDrugName).includes(normalize(candidate));
}

export async function checkBeersCriteria(drugName: string): Promise<BeersFlag | null> {
  const { flagged_drugs } = await loadBeers();
  return (
    flagged_drugs.find(
      (d: any) =>
        nameMatches(drugName, d.drug_name) || (d.aliases || []).some((a: string) => nameMatches(drugName, a))
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
  return interactions.filter((i) => {
    const newMatchesA = nameMatches(newDrug, i.drug_a);
    const newMatchesB = nameMatches(newDrug, i.drug_b);
    if (!newMatchesA && !newMatchesB) return false;
    const otherCandidate = newMatchesA ? i.drug_b : i.drug_a;
    return existingDrugs.some((d) => nameMatches(d, otherCandidate));
  });
}

export async function fullSafetyCheck(newDrug: string, existingDrugs: string[]) {
  const [beers, interactions] = await Promise.all([
    checkBeersCriteria(newDrug),
    checkInteractions(newDrug, existingDrugs),
  ]);
  return { beers, interactions };
}
