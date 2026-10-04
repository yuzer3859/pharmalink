import { MatchStatusPolicy } from './match-status-policy';
import { MatchStatus } from '../enums';

describe('MatchStatusPolicy', () => {
  describe('valid transitions', () => {
    it('allows PENDING -> MATCHED (SelectMatchCommand succeeds)', () => {
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.PENDING, MatchStatus.MATCHED)).toBe(
        true,
      );
    });

    it('allows PENDING -> FAILED (no candidates left)', () => {
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.PENDING, MatchStatus.FAILED)).toBe(
        true,
      );
    });

    it('allows MATCHED -> REMATCHING (RematchCommand entry point, §16 edge case 5)', () => {
      expect(
        MatchStatusPolicy.isLegalTransition(MatchStatus.MATCHED, MatchStatus.REMATCHING),
      ).toBe(true);
    });

    it('allows MATCHED -> FAILED (terminal, no candidates left)', () => {
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.MATCHED, MatchStatus.FAILED)).toBe(
        true,
      );
    });

    it('allows REMATCHING -> MATCHED (RematchCommand finds a new candidate)', () => {
      expect(
        MatchStatusPolicy.isLegalTransition(MatchStatus.REMATCHING, MatchStatus.MATCHED),
      ).toBe(true);
    });

    it('allows REMATCHING -> FAILED (RematchCommand exhausts all candidates)', () => {
      expect(
        MatchStatusPolicy.isLegalTransition(MatchStatus.REMATCHING, MatchStatus.FAILED),
      ).toBe(true);
    });
  });

  describe('invalid transitions', () => {
    it('rejects any transition out of a terminal FAILED status', () => {
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.FAILED, MatchStatus.PENDING)).toBe(
        false,
      );
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.FAILED, MatchStatus.MATCHED)).toBe(
        false,
      );
      expect(
        MatchStatusPolicy.isLegalTransition(MatchStatus.FAILED, MatchStatus.REMATCHING),
      ).toBe(false);
    });

    it('rejects REMATCHING -> REMATCHING (no self-transition)', () => {
      expect(
        MatchStatusPolicy.isLegalTransition(MatchStatus.REMATCHING, MatchStatus.REMATCHING),
      ).toBe(false);
    });

    it('rejects MATCHED -> MATCHED (must go through REMATCHING, not collapsed)', () => {
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.MATCHED, MatchStatus.MATCHED)).toBe(
        false,
      );
    });

    it('rejects PENDING -> REMATCHING (REMATCHING only reachable from MATCHED)', () => {
      expect(
        MatchStatusPolicy.isLegalTransition(MatchStatus.PENDING, MatchStatus.REMATCHING),
      ).toBe(false);
    });

    it('rejects skipping straight from PENDING to REMATCHING or backwards MATCHED -> PENDING', () => {
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.MATCHED, MatchStatus.PENDING)).toBe(
        false,
      );
    });

    it('PARTIAL has no legal incoming or outgoing transitions (unused in Slice 1, not inferred)', () => {
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.PENDING, MatchStatus.PARTIAL)).toBe(
        false,
      );
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.MATCHED, MatchStatus.PARTIAL)).toBe(
        false,
      );
      expect(
        MatchStatusPolicy.isLegalTransition(MatchStatus.REMATCHING, MatchStatus.PARTIAL),
      ).toBe(false);
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.PARTIAL, MatchStatus.MATCHED)).toBe(
        false,
      );
      expect(MatchStatusPolicy.isLegalTransition(MatchStatus.PARTIAL, MatchStatus.FAILED)).toBe(
        false,
      );
    });

    it('assertValidTransition throws INVALID_MATCH_STATE_TRANSITION for an illegal transition', () => {
      expect(() =>
        MatchStatusPolicy.assertValidTransition(MatchStatus.FAILED, MatchStatus.MATCHED),
      ).toThrow();
    });
  });

  describe('§16 edge case 5 — RematchCommand called on a MATCHED request', () => {
    it('allows the intermediate MATCHED -> REMATCHING transition the command relies on internally', () => {
      expect(() =>
        MatchStatusPolicy.assertValidTransition(MatchStatus.MATCHED, MatchStatus.REMATCHING),
      ).not.toThrow();
    });
  });

  describe('assertValidTransition happy paths', () => {
    it('does not throw for PENDING -> MATCHED', () => {
      expect(() =>
        MatchStatusPolicy.assertValidTransition(MatchStatus.PENDING, MatchStatus.MATCHED),
      ).not.toThrow();
    });

    it('does not throw for REMATCHING -> MATCHED', () => {
      expect(() =>
        MatchStatusPolicy.assertValidTransition(MatchStatus.REMATCHING, MatchStatus.MATCHED),
      ).not.toThrow();
    });
  });
});
