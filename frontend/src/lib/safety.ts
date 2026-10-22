"use client";

import { INTERACTION_RULES } from "./interactionRules";

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

async function loadBeers() {
  if (!beersCache) beersCache = await (await fetch("/data/beers_criteria.json")).json();
  return beersCache!;
}

function normalize(name: string) {
  return name.trim().toLowerCase();
}

// Scanned drug names come back from the backend as full RxNorm-style
// strings ("ibuprofen 200 MG Oral Tablet"), not bare generic names, so an
// exact-equality check against a flagged entry's "ibuprofen" would never
// match anything -- the Beers check would silently always come back clean
// regardless of what was actually scanned. Match by substring instead.
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

// Whole-word match of an ingredient in a full drug name ("ibuprofen" in
// "ibuprofen 200 MG Oral Tablet"; "potassium chloride" but not the
// "potassium" in "losartan potassium").
function containsIngredient(drugName: string, ingredient: string): boolean {
  const escaped = ingredient.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i").test(drugName);
}

function firstMatch(drugName: string, ingredients: string[]): string | null {
  return ingredients.find((i) => containsIngredient(drugName, i)) ?? null;
}

// Every rule-based interaction between two different medications.
function interactionsBetween(a: string, b: string): InteractionFlag[] {
  const out: InteractionFlag[] = [];
  for (const rule of INTERACTION_RULES) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const ix = firstMatch(x, rule.a);
      const iy = firstMatch(y, rule.b);
      // The same ingredient in both is a duplicate, not an interaction
      // (checkDuplicateIngredients reports that).
      if (ix && iy && ix !== iy) {
        out.push({ drug_a: x, drug_b: y, severity: rule.severity, description: rule.description });
        break;
      }
    }
  }
  return out;
}

// All interactions among a list of medications, high severity first.
export function checkInteractionsAmong(drugNames: string[]): InteractionFlag[] {
  const names = [...new Set(drugNames)];
  const seen = new Set<string>();
  const out: InteractionFlag[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      for (const f of interactionsBetween(names[i], names[j])) {
        const key = [f.drug_a, f.drug_b].sort().join("|") + "|" + f.description;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(f);
        }
      }
    }
  }
  return out.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "high" ? -1 : 1));
}

// A newly scanned drug against the user's existing medications.
export async function checkInteractions(newDrug: string, existingDrugs: string[]): Promise<InteractionFlag[]> {
  const others = existingDrugs.filter((d) => normalize(d) !== normalize(newDrug));
  return checkInteractionsAmong([newDrug, ...others]).filter((f) => f.drug_a === newDrug || f.drug_b === newDrug);
}

// Words that aren't active ingredients (forms, salts, units, marketing).
const NOT_INGREDIENTS = new Set([
  "tablet", "tablets", "capsule", "capsules", "oral", "extended", "release", "delayed", "film", "coated",
  "chewable", "orally", "disintegrating", "hydrochloride", "sodium", "potassium", "calcium", "magnesium",
  "sulfate", "maleate", "mesylate", "besylate", "tartrate", "succinate", "citrate", "phosphate", "acetate",
  "bromide", "fumarate", "hyclate", "monohydrate", "anhydrous", "strength", "extra", "regular", "maximum",
  "relief", "adult", "adults", "children", "childrens", "night", "daytime", "nighttime", "formula", "caplet",
  "caplets", "softgel", "softgels", "gelcap", "gelcaps", "solution", "suspension", "liquid", "injection",
  "cream", "pack", "with", "plus", "severe", "multi", "symptom", "allergy", "sinus", "headache", "migraine",
  "sleep", "enteric", "rapid", "chewables", "tabs",
]);

function ingredientWords(drugName: string): Set<string> {
  return new Set((drugName.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length >= 5 && !NOT_INGREDIENTS.has(w)));
}

export interface DuplicateIngredient {
  ingredient: string;
  drugs: string[];
}

// The same active ingredient in two or more medications -- a leading cause
// of accidental overdose (e.g. acetaminophen in Tylenol, a cold medicine
// and a prescription painkiller at once).
export function checkDuplicateIngredients(drugNames: string[]): DuplicateIngredient[] {
  const byWord = new Map<string, string[]>();
  for (const name of new Set(drugNames)) {
    for (const w of ingredientWords(name)) byWord.set(w, [...(byWord.get(w) || []), name]);
  }
  return [...byWord.entries()]
    .filter(([, drugs]) => drugs.length > 1)
    .map(([ingredient, drugs]) => ({ ingredient, drugs }));
}

export async function fullSafetyCheck(newDrug: string, existingDrugs: string[]) {
  const others = existingDrugs.filter((d) => normalize(d) !== normalize(newDrug));
  const [beers, interactions] = await Promise.all([checkBeersCriteria(newDrug), checkInteractions(newDrug, others)]);
  const duplicates = checkDuplicateIngredients([newDrug, ...others]).filter((d) => d.drugs.includes(newDrug));
  return { beers, interactions, duplicates };
}
