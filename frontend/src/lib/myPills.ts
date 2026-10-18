import type { ReferencePill } from "./db";

// "My Pills" matching: compare a scan against the user's own saved photos of
// their own pills. Same scoring the backend uses against the gallery
// (per query side, best cosine similarity over the saved pill's photos;
// then averaged across sides), so scores are directly comparable with the
// gallery matches' `score`.
//
// Why this matters: for most drugs the gallery only has package/label art,
// not a photo of the pill -- but a user's own photo of their own pill (same
// manufacturer, same pharmacy) is about as close a reference as exists.

export type MyPillMatch = { pill: ReferencePill; score: number };

// Thresholds are conservative starting points, not calibrated on real
// phone-photo data yet -- revisit once there's a test set of re-scans.
// "strong" also requires beating the best gallery match, so an unrelated
// pill that merely resembles a saved one doesn't get a confident banner.
// Calibrated with eval_my_pills.py (V3 + LoRA, 8,000 simulated scans of
// real ePillID phone photos): same values as MY_PILLS below.
export const MY_PILL_STRONG = 0.97;
export const MY_PILL_POSSIBLE = 0.94;
const STRONG_MARGIN_OVER_GALLERY = 0.02;
const POSSIBLE_MARGIN_UNDER_GALLERY = 0.05;

function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// Embeddings arrive L2-normalized from the backend, so a dot product is the
// cosine similarity. Re-normalizing guards against rounding drift.
function normalize(v: number[]): number[] {
  const norm = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / norm);
}

export function scoreMyPills(queryEmbeddings: number[][], pills: ReferencePill[]): MyPillMatch[] {
  const queries = queryEmbeddings.map(normalize);
  const scored: MyPillMatch[] = [];
  for (const pill of pills) {
    if (!pill.embeddings || pill.embeddings.length === 0) continue;
    const refs = [...pill.embeddings, ...(pill.learnedEmbeddings ?? [])].map(normalize);
    const perSide = queries.map((q) => Math.max(...refs.map((r) => dot(q, r))));
    scored.push({ pill, score: perSide.reduce((a, b) => a + b, 0) / perSide.length });
  }
  return scored.sort((a, b) => b.score - a.score);
}

export type MyPillVerdict = { kind: "strong" | "possible"; match: MyPillMatch; runnerUp: MyPillMatch | null } | null;

export function judgeMyPillMatch(ranked: MyPillMatch[], galleryTopScore: number): MyPillVerdict {
  const best = ranked[0];
  if (!best) return null;
  // A second saved pill scoring almost as high means the photo can't tell
  // them apart -- surface it so the user compares both.
  const runnerUp = ranked[1] && best.score - ranked[1].score < 0.02 ? ranked[1] : null;
  if (best.score >= MY_PILL_STRONG && best.score >= galleryTopScore + STRONG_MARGIN_OVER_GALLERY) {
    return { kind: "strong", match: best, runnerUp };
  }
  if (best.score >= MY_PILL_POSSIBLE && best.score >= galleryTopScore - POSSIBLE_MARGIN_UNDER_GALLERY) {
    return { kind: "possible", match: best, runnerUp };
  }
  return null;
}

// ── Checking a pill against the patient's own medicines ──────────────────
// The main flow for a senior: "which of MY medicines is this?" -- a few
// candidates, each with the patient's own photo as the reference. Three
// answers: it IS one of them; it could be one of two (check the letters);
// or it doesn't look like any of them (don't take it). The last answer is
// the safety net -- a spouse's pill or a wrong pill in the organizer must
// not be forced onto one of the patient's medicines.
//
// Thresholds from backend/scripts/eval_my_pills.py on the real V3 model
// (4,000 normal + 4,000 look-alike households of real ePillID phone photos,
// plus other people's pills). Right medicine first: 96% (89% with a
// look-alike in the household). With these: "This is your X" 59% of scans,
// wrong 0.9%; "check the letters" 35%; false "not yours" 4.5%; other
// people's pills caught 84%, wrongly confirmed 1.7%. Optimistic: V3 trained
// on these photos. Confirmed answers also show the letters to check.
export const MY_PILLS = { REJECT: 0.94, MATCH: 0.97, MARGIN: 0.02 };

export type MedMatch = { key: string; pill: ReferencePill; score: number };

export const MAX_LEARNED = 8;

// The pill with this scan added to what it's matched against (only used
// after a confident automatic match -- never on a guess or a user's pick).
export function withLearnedScan(pill: ReferencePill, scan: number[][]): ReferencePill {
  const learned = [...(pill.learnedEmbeddings ?? []), ...scan].slice(-MAX_LEARNED);
  return { ...pill, learnedEmbeddings: learned };
}

// One row per medicine (a medicine may have several saved photos/pills).
export function rankMyMedicines(queryEmbeddings: number[][], pills: ReferencePill[]): MedMatch[] {
  const best = new Map<string, MedMatch>();
  for (const { pill, score } of scoreMyPills(queryEmbeddings, pills)) {
    const key = `${pill.drugName.trim().toLowerCase()}|${pill.ndc || ""}`;
    if (!best.has(key) || best.get(key)!.score < score) best.set(key, { key, pill, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export type CheckResult =
  | { kind: "match"; best: MedMatch }
  | { kind: "check"; options: MedMatch[] }
  | { kind: "none"; closest: MedMatch | null };

export function checkMyPill(ranked: MedMatch[], t = MY_PILLS): CheckResult {
  const [first, second] = ranked;
  if (!first || first.score < t.REJECT) return { kind: "none", closest: first ?? null };
  const margin = first.score - (second ? second.score : -1);
  if (first.score >= t.MATCH && margin >= t.MARGIN) return { kind: "match", best: first };
  const options = [first];
  if (second && second.score >= t.REJECT && margin < t.MARGIN) options.push(second);
  return { kind: "check", options };
}
