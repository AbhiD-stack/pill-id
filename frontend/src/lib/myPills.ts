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
// Settings from backend/scripts/eval_my_pills.py on the real V3 model.
// "raw" = plain similarity to the saved photos; "snorm" = similarity
// normalized against how alike the photo is to pills in general (cohort
// statistics from the server's catalog), which keeps a look-alike-of-
// everything pill from scoring high. MODE is the one the evaluation found
// safest; raw is used whenever a pill's statistics aren't available yet.
//
// raw, first run (4,000 normal + 4,000 look-alike households of real ePillID
// phone photos): right medicine first 96% (89% with a look-alike); "This is
// your X" 59% of scans, wrong 0.9%; others' pills wrongly confirmed 1.7%.
// Optimistic: V3 trained on these photos. Confirmed answers also show the
// letters to check.
export type Thresholds = { REJECT: number; MATCH: number; MARGIN: number };
//
// snorm + both sides (second run, same households, strictest safety level):
// right medicine first 97.5% (92.6% with a look-alike); "This is your X"
// 40.6% of scans, wrong 0.04%; "check the letters" 59.4% (right one first
// 92%); own pill called "not yours" 0%; others' pills wrongly confirmed
// 0.10%. Plain scores with one photo could not reach this safety level.
export const MY_PILLS: { MODE: "raw" | "snorm"; PHOTOS: 1 | 2; raw: Thresholds; snorm: Thresholds } = {
  MODE: "snorm",
  PHOTOS: 2,
  raw: { REJECT: 0.94, MATCH: 0.97, MARGIN: 0.02 }, // fallback while a pill's statistics are missing
  snorm: { REJECT: -47.2294, MATCH: 3.6515, MARGIN: 4.779 },
};

export type ScanQuery = { embeddings: number[][]; cohort: number[][] | null };
export type MedMatch = { key: string; pill: ReferencePill; score: number };

export const MAX_LEARNED = 8;

const hasCohort = (p: ReferencePill) =>
  !!p.cohort && p.cohort.length === (p.embeddings?.length ?? 0) &&
  (p.learnedCohort?.length ?? 0) === (p.learnedEmbeddings?.length ?? 0);

// The pill with this scan added to what it's matched against (only used
// after a confident automatic match -- never on a guess or a user's pick).
export function withLearnedScan(pill: ReferencePill, scan: ScanQuery): ReferencePill {
  const learned = [...(pill.learnedEmbeddings ?? []), ...scan.embeddings].slice(-MAX_LEARNED);
  const cohort = scan.cohort && (pill.learnedCohort?.length ?? 0) === (pill.learnedEmbeddings?.length ?? 0)
    ? [...(pill.learnedCohort ?? []), ...scan.cohort].slice(-MAX_LEARNED)
    : undefined; // re-filled from the server later
  return { ...pill, learnedEmbeddings: learned, learnedCohort: cohort };
}

// One row per medicine (a medicine may have several saved photos/pills),
// with the scoring mode actually used (and so which thresholds apply).
export function rankMyMedicines(query: ScanQuery, pills: ReferencePill[]): { ranked: MedMatch[]; mode: "raw" | "snorm" } {
  const usable = pills.filter((p) => p.embeddings && p.embeddings.length > 0);
  const mode = MY_PILLS.MODE === "snorm" && query.cohort && usable.every(hasCohort) ? "snorm" : "raw";
  const qs = query.embeddings.map(normalize);
  const best = new Map<string, MedMatch>();
  for (const pill of usable) {
    const refs = [...pill.embeddings!, ...(pill.learnedEmbeddings ?? [])].map(normalize);
    const refStats = [...(pill.cohort ?? []), ...(pill.learnedCohort ?? [])];
    const perSide = qs.map((q, qi) =>
      Math.max(
        ...refs.map((r, ri) => {
          const c = dot(q, r);
          if (mode === "raw") return c;
          const [qm, qsd] = query.cohort![qi];
          const [rm, rsd] = refStats[ri];
          return 0.5 * ((c - qm) / qsd + (c - rm) / rsd);
        })
      )
    );
    const score = perSide.reduce((a, b) => a + b, 0) / perSide.length;
    const key = `${pill.drugName.trim().toLowerCase()}|${pill.ndc || ""}`;
    if (!best.has(key) || best.get(key)!.score < score) best.set(key, { key, pill, score });
  }
  return { ranked: [...best.values()].sort((a, b) => b.score - a.score), mode };
}

export type CheckResult =
  | { kind: "match"; best: MedMatch }
  | { kind: "check"; options: MedMatch[] }
  | { kind: "none"; closest: MedMatch | null };

export function checkMyPill(ranked: MedMatch[], t: Thresholds = MY_PILLS.raw): CheckResult {
  const [first, second] = ranked;
  if (!first || first.score < t.REJECT) return { kind: "none", closest: first ?? null };
  const margin = first.score - (second ? second.score : -1e9);
  if (first.score >= t.MATCH && margin >= t.MARGIN) return { kind: "match", best: first };
  const options = [first];
  if (second && second.score >= t.REJECT && margin < t.MARGIN) options.push(second);
  return { kind: "check", options };
}
