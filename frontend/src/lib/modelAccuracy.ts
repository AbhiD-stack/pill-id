// Real numbers from the training run's own held-out evaluation
// (deploy_report.json, priority-tier restricted-gallery search), not
// marketing copy. Two things worth internalizing before trusting any
// single score:
//
// 1. Even on curated/studio-style test photos -- not real phone photos --
//    the #1 match is wrong a large fraction of the time, especially for
//    RX drugs. "Top match" is not "the answer."
// 2. The eval's own calibration curve is nearly FLAT: precision stays
//    ~constant whether the match score is 5% or 95%. The visual-similarity
//    score does not reliably predict correctness -- a 92% score is not
//    meaningfully safer to trust than a 40% one. This is why the UI shows
//    this as "visual match," never "confidence."
export const MEASURED_ACCURACY: Record<"RX" | "OTC" | "overall", { top1: number; top5: number; top10: number }> = {
  RX: { top1: 0.575, top5: 0.856, top10: 0.933 },
  OTC: { top1: 0.789, top5: 0.964, top10: 0.977 },
  overall: { top1: 0.626, top5: 0.882, top10: 0.944 },
};

export function accuracyDisclaimer(rxOrOtc: "RX" | "OTC" | null): string {
  const stats = rxOrOtc && MEASURED_ACCURACY[rxOrOtc] ? MEASURED_ACCURACY[rxOrOtc] : MEASURED_ACCURACY.overall;
  const label = rxOrOtc === "RX" ? "RX" : rxOrOtc === "OTC" ? "OTC" : "overall";
  return (
    `On our own test photos, the top match for ${label} drugs is correct about ${Math.round(stats.top1 * 100)}% ` +
    `of the time (the right answer is somewhere in the top 5 about ${Math.round(stats.top5 * 100)}% of the time). ` +
    `Real phone photos can do worse than that. The match score is a similarity score, not a confidence level -- ` +
    `a high score does not mean it's more likely to be correct. Always check imprint, color, and shape against ` +
    `the physical pill before trusting any result.`
  );
}
