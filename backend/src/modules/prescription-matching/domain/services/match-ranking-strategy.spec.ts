import { MatchRankingStrategy } from './match-ranking-strategy';

describe('MatchRankingStrategy', () => {
  it('returns an empty ranked list for an empty candidate array (not an error at this layer)', () => {
    expect(MatchRankingStrategy.rank([], { distanceWeight: 0.7, priceWeight: 0.3 })).toEqual([]);
  });

  it('ranks the closer candidate first when distance dominates, even if it is more expensive', () => {
    const ranked = MatchRankingStrategy.rank(
      [
        { pharmacyId: 'far-cheap', branchId: 'b1', distanceMeters: 5000, totalPrice: 100 },
        { pharmacyId: 'near-expensive', branchId: 'b2', distanceMeters: 500, totalPrice: 500 },
      ],
      { distanceWeight: 0.9, priceWeight: 0.1 },
    );
    expect(ranked[0].pharmacyId).toBe('near-expensive');
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].pharmacyId).toBe('far-cheap');
    expect(ranked[1].rank).toBe(2);
  });

  it('falls back to price when distance is identical across all candidates', () => {
    const ranked = MatchRankingStrategy.rank(
      [
        { pharmacyId: 'expensive', branchId: 'b1', distanceMeters: 1000, totalPrice: 500 },
        { pharmacyId: 'cheap', branchId: 'b2', distanceMeters: 1000, totalPrice: 100 },
      ],
      { distanceWeight: 0.7, priceWeight: 0.3 },
    );
    expect(ranked[0].pharmacyId).toBe('cheap');
    expect(ranked[1].pharmacyId).toBe('expensive');
  });

  it('does not divide by zero when every candidate shares the same price', () => {
    const ranked = MatchRankingStrategy.rank(
      [
        { pharmacyId: 'a', branchId: 'b1', distanceMeters: 1000, totalPrice: 200 },
        { pharmacyId: 'b', branchId: 'b2', distanceMeters: 2000, totalPrice: 200 },
      ],
      { distanceWeight: 0.7, priceWeight: 0.3 },
    );
    expect(ranked.every((c) => Number.isFinite(c.score))).toBe(true);
    expect(ranked[0].pharmacyId).toBe('a');
  });

  it('breaks ties by stable input order when scores are exactly equal', () => {
    const ranked = MatchRankingStrategy.rank(
      [
        { pharmacyId: 'first', branchId: 'b1', distanceMeters: 1000, totalPrice: 200 },
        { pharmacyId: 'second', branchId: 'b2', distanceMeters: 1000, totalPrice: 200 },
      ],
      { distanceWeight: 0.7, priceWeight: 0.3 },
    );
    expect(ranked[0].pharmacyId).toBe('first');
    expect(ranked[1].pharmacyId).toBe('second');
  });

  it('assigns sequential ranks starting at 1', () => {
    const ranked = MatchRankingStrategy.rank(
      [
        { pharmacyId: 'a', branchId: 'b1', distanceMeters: 3000, totalPrice: 300 },
        { pharmacyId: 'b', branchId: 'b2', distanceMeters: 1000, totalPrice: 100 },
        { pharmacyId: 'c', branchId: 'b3', distanceMeters: 2000, totalPrice: 200 },
      ],
      { distanceWeight: 0.7, priceWeight: 0.3 },
    );
    expect(ranked.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  it('never scores against a rating term — the input/output shape has no rating field (§0.2 regression)', () => {
    const candidateWithStrayRatingField = {
      pharmacyId: 'a',
      branchId: 'b1',
      distanceMeters: 1000,
      totalPrice: 200,
      rating: 1, // not part of AvailabilityCandidate — must be ignored, not scored against
    };
    const candidateWithoutRating = {
      pharmacyId: 'b',
      branchId: 'b2',
      distanceMeters: 1000,
      totalPrice: 200,
    };
    const ranked = MatchRankingStrategy.rank(
      [candidateWithStrayRatingField, candidateWithoutRating],
      { distanceWeight: 0.7, priceWeight: 0.3 },
    );
    // Identical distance/price -> identical score regardless of the stray `rating` field.
    expect(ranked[0].score).toBe(ranked[1].score);
  });
});
