export interface AvailabilityCandidate {
  pharmacyId: string;
  branchId: string;
  distanceMeters: number;
  totalPrice: number;
}

export interface RankingWeightsInput {
  distanceWeight: number;
  priceWeight: number;
}

export interface RankedCandidate extends AvailabilityCandidate {
  rank: number;
  score: number;
}

/**
 * `MatchRankingStrategy` (module-05 §3.9, §8 step 3, FR-MATCH-02/03). Pure, unit-testable with
 * fixed candidate arrays — no DB, no geo service. `score = weights.distanceWeight ·
 * norm(distance) + weights.priceWeight · norm(totalPrice)`; a lower score ranks first (rank 1 =
 * best). Both terms are min-max normalized across the candidate set to `[0, 1]` so the two
 * weights are comparable regardless of their raw units (meters vs. minor-currency-units) — when
 * every candidate shares the same distance (or price), that term normalizes to `0` for all of
 * them rather than dividing by zero. Distance is "dominant by default" only because the caller
 * is expected to supply a distance-dominant `RankingWeights` (§0.1) — this function itself has
 * no opinion on the weight values, only on how they combine. Deliberately has **no rating term**
 * anywhere in its signature or scoring (§0.2 — Module 15/Reviews does not exist yet); this is a
 * regression requirement (§18.1), not an oversight, so no field is silently added here later
 * without a conscious spec change. An empty candidate list is not an error at this layer (that
 * decision, `NO_PHARMACY_MATCH`, belongs to the application layer) — it simply ranks to an empty
 * array. Ties are broken by stable input order.
 */
export const MatchRankingStrategy = {
  rank(candidates: AvailabilityCandidate[], weights: RankingWeightsInput): RankedCandidate[] {
    if (candidates.length === 0) {
      return [];
    }

    const normDistance = normalizer(candidates.map((c) => c.distanceMeters));
    const normPrice = normalizer(candidates.map((c) => c.totalPrice));

    return candidates
      .map((candidate, index) => ({
        candidate,
        index,
        score:
          weights.distanceWeight * normDistance(candidate.distanceMeters) +
          weights.priceWeight * normPrice(candidate.totalPrice),
      }))
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map(({ candidate, score }, i) => ({ ...candidate, score, rank: i + 1 }));
  },
};

function normalizer(values: number[]): (value: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) {
    return () => 0;
  }
  return (value: number) => (value - min) / range;
}
