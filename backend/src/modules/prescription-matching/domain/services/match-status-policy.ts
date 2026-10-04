import { PrescriptionMatchingErrors } from '../errors';
import { MatchStatus } from '../enums';

/**
 * Pure state machine for `MatchRequest.status` (module-05 §3.11 invariant 8, §8.4, §16 edge case
 * 5). Slice 1's write-time transition graph, exactly as narrated by the spec's invariant 8: "only
 * `PENDING -> MATCHED`, `MATCHED -> REMATCHING -> MATCHED`, or `-> FAILED` (terminal, no
 * candidates left)":
 *  - `PENDING -> MATCHED`: `SelectMatchCommand` succeeds (§10.3 `/matching/:id/select`).
 *  - `PENDING -> FAILED`: no candidates remain (terminal).
 *  - `MATCHED -> REMATCHING`: `RematchCommand` called on a `MATCHED` request — the "pharmacy
 *    declined" entry point (§16 edge case 5) — transitions internally before re-ranking. This
 *    intermediate state must never be collapsed into `MATCHED -> MATCHED`.
 *  - `MATCHED -> FAILED`: terminal, no candidates left.
 *  - `REMATCHING -> MATCHED`: `RematchCommand` finds a new candidate and re-selects (§9
 *    `RematchTriggered`).
 *  - `REMATCHING -> FAILED`: `RematchCommand` exhausts all candidates (§9 `MatchFailed`).
 * `FAILED` is terminal (no legal outgoing transition) — an invalid transition (e.g. selecting on
 * a `FAILED` request) throws `INVALID_MATCH_STATE_TRANSITION` (§15.2). `PARTIAL` is a
 * schema-level enum value with no defined role anywhere in this slice's narrated flow (no
 * reference anywhere in the spec body) and is likewise absent from this transition graph, not
 * inferred — nothing transitions into or out of it here.
 */
const LEGAL_TRANSITIONS: Record<MatchStatus, ReadonlySet<MatchStatus>> = {
  [MatchStatus.PENDING]: new Set([MatchStatus.MATCHED, MatchStatus.FAILED]),
  [MatchStatus.MATCHED]: new Set([MatchStatus.REMATCHING, MatchStatus.FAILED]),
  [MatchStatus.REMATCHING]: new Set([MatchStatus.MATCHED, MatchStatus.FAILED]),
  [MatchStatus.PARTIAL]: new Set(),
  [MatchStatus.FAILED]: new Set(),
};

export const MatchStatusPolicy = {
  isLegalTransition(from: MatchStatus, to: MatchStatus): boolean {
    return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
  },

  assertValidTransition(from: MatchStatus, to: MatchStatus): void {
    if (!MatchStatusPolicy.isLegalTransition(from, to)) {
      throw PrescriptionMatchingErrors.invalidMatchStateTransition(from, to);
    }
  },
};
