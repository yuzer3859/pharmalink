import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import { MatchCoverage, MatchStrategy } from '../../domain/enums';
import { AvailabilityCandidate, MatchRankingStrategy } from '../../domain/services/match-ranking-strategy';
import { RankingWeights } from '../../domain/value-objects/ranking-weights';
import {
  IMatchRepository,
  MATCH_REPOSITORY,
  MatchCandidateSnapshot,
  MatchRequestSnapshot,
  NewMatchCandidateData,
} from '../../domain/repositories/match.repository';
import { AVAILABILITY_PORT, IAvailabilityPort } from '../ports/outbound/availability.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithMatchRetry } from '../support/match-retry';

export interface FindMatchLineInput {
  catalogProductId: string;
  quantity: number;
}

export interface FindMatchInput {
  customerUserId: string;
  lines: FindMatchLineInput[];
  deliveryLat?: number;
  deliveryLng?: number;
}

export interface FindMatchResult {
  matchRequest: MatchRequestSnapshot;
  candidates: MatchCandidateSnapshot[];
}

/** Distance-dominant default (§0.1) — used only when `matching.rankingWeights` (§3.8) is unset. */
const DEFAULT_RANKING_WEIGHTS = { distanceWeight: 0.7, priceWeight: 0.3 };

/**
 * `POST /matching/find` (module-05 §3.10 `MatchingEngine`, §5.5, §8.3, §12 "Find match").
 * Single-pharmacy coverage only (§0.2) — for each candidate pharmacy/branch returned by
 * `IAvailabilityPort` for every requested line, only pharmacies that can fully cover **every**
 * line (§3.11 invariant 6: only pharmacies Module 04's availability query already returned) are
 * ranked; a pharmacy short on stock for any one line is excluded rather than offered as a
 * partial/split proposal (§5.5 business validation — no split fulfillment in Slice 1). Ranking
 * itself is read-only (no lock, §8.2/§8.3); only the `MatchRequest`+`MatchCandidate` persistence
 * step runs inside a `Serializable` transaction with the bounded retry wrapper (§2.1.1/§12) — no
 * outbox event is written here (`00-domain-event-catalog.md`'s Module 05 row has no "match
 * found" event; `OrderMatched`/`RematchTriggered`/`MatchFailed` are `SelectMatchCommand`/
 * `RematchCommand`'s events, not this one's).
 */
@Injectable()
export class FindMatchCommand {
  constructor(
    @Inject(MATCH_REPOSITORY) private readonly matches: IMatchRepository,
    @Inject(AVAILABILITY_PORT) private readonly availability: IAvailabilityPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: FindMatchInput): Promise<FindMatchResult> {
    if (input.lines.length === 0) {
      throw PrescriptionMatchingErrors.validation('At least one line is required.', {
        field: 'lines',
      });
    }

    const geo =
      input.deliveryLat !== undefined && input.deliveryLng !== undefined
        ? { lat: input.deliveryLat, lng: input.deliveryLng }
        : undefined;

    const byPharmacyBranch = new Map<
      string,
      { pharmacyId: string; branchId: string; totalPrice: number; distanceMeters?: number; coveredLines: number }
    >();

    for (const line of input.lines) {
      const rows = await this.availability.getAvailability(line.catalogProductId, geo);
      for (const row of rows) {
        if (row.sellable < line.quantity) {
          continue;
        }
        const key = `${row.pharmacyId}:${row.branchId}`;
        const existing = byPharmacyBranch.get(key);
        if (existing) {
          existing.totalPrice += row.price * line.quantity;
          existing.coveredLines += 1;
        } else {
          byPharmacyBranch.set(key, {
            pharmacyId: row.pharmacyId,
            branchId: row.branchId,
            totalPrice: row.price * line.quantity,
            distanceMeters: row.distanceMeters,
            coveredLines: 1,
          });
        }
      }
    }

    const fullCoverage: AvailabilityCandidate[] = [...byPharmacyBranch.values()]
      .filter((c) => c.coveredLines === input.lines.length)
      .map((c) => ({
        pharmacyId: c.pharmacyId,
        branchId: c.branchId,
        totalPrice: c.totalPrice,
        distanceMeters: c.distanceMeters ?? 0,
      }));

    if (fullCoverage.length === 0) {
      throw PrescriptionMatchingErrors.noPharmacyMatch();
    }

    const weightsConfig = this.config.get<{ distanceWeight: number; priceWeight: number }>(
      'matching.rankingWeights',
    );
    const weights = RankingWeights.of(weightsConfig ?? DEFAULT_RANKING_WEIGHTS);

    const ranked = MatchRankingStrategy.rank(fullCoverage, {
      distanceWeight: weights.distanceWeight,
      priceWeight: weights.priceWeight,
    });

    const candidateData: NewMatchCandidateData[] = ranked.map((r) => ({
      pharmacyId: r.pharmacyId,
      branchId: r.branchId,
      coverage: MatchCoverage.ALL,
      totalPrice: r.totalPrice,
      distanceMeters: r.distanceMeters,
      rank: r.rank,
    }));

    return runWithMatchRetry(this.uow, async (tx) => {
      const { matchRequest, candidates } = await this.matches.createWithCandidates(
        {
          customerUserId: input.customerUserId,
          deliveryLat: input.deliveryLat ?? null,
          deliveryLng: input.deliveryLng ?? null,
          strategy: MatchStrategy.SINGLE,
        },
        candidateData,
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.customerUserId,
          action: 'MATCH_REQUEST_CREATED',
          resourceType: 'MatchRequest',
          resourceId: matchRequest.id,
          context: { candidateCount: candidates.length },
        },
        tx,
      );

      return { matchRequest, candidates };
    });
  }
}
