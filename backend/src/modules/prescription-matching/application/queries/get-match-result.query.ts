import { Inject, Injectable } from '@nestjs/common';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import {
  IMatchRepository,
  MATCH_REPOSITORY,
  MatchCandidateSnapshot,
  MatchRequestSnapshot,
} from '../../domain/repositories/match.repository';

export interface GetMatchResultInput {
  matchRequestId: string;
  customerUserId: string;
}

export interface MatchResultView {
  matchRequest: MatchRequestSnapshot;
  candidates: MatchCandidateSnapshot[];
}

/**
 * `GET /matching/:id` (module-05 §10.3) — status + ranked candidates + chosen result, scoped to
 * the requesting customer (`matchRequest.customerUserId`, §7.3). Not found and not-owned are
 * collapsed into the same generic not-found response (same existence-leak-avoidance discipline
 * as prescriptions, §14) — reuses `PRESCRIPTION_NOT_FOUND`'s error code with a match-specific
 * message since no dedicated `MATCH_REQUEST_NOT_FOUND` code exists in `error-codes.ts` (§15.2's
 * error table lists no such code, and adding one is a shared-file change out of this task's
 * repository/application-layer scope).
 */
@Injectable()
export class GetMatchResultQuery {
  constructor(@Inject(MATCH_REPOSITORY) private readonly matches: IMatchRepository) {}

  async execute(input: GetMatchResultInput): Promise<MatchResultView> {
    const matchRequest = await this.matches.findById(input.matchRequestId);
    if (!matchRequest || matchRequest.customerUserId !== input.customerUserId) {
      throw PrescriptionMatchingErrors.notFound('Match request not found');
    }
    const candidates = await this.matches.listCandidates(matchRequest.id);
    return { matchRequest, candidates };
  }
}
