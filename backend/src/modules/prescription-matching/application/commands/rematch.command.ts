import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { MatchCoverage, MatchStatus } from '../../domain/enums';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import { matchFailedEvent, rematchTriggeredEvent } from '../../domain/events';
import {
  IMatchRepository,
  MATCH_REPOSITORY,
  MatchRequestSnapshot,
  NewMatchCandidateData,
} from '../../domain/repositories/match.repository';
import { MatchStatusPolicy } from '../../domain/services/match-status-policy';
import { AvailabilityCandidate, MatchRankingStrategy } from '../../domain/services/match-ranking-strategy';
import { RankingWeights } from '../../domain/value-objects/ranking-weights';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { AVAILABILITY_PORT, IAvailabilityPort } from '../ports/outbound/availability.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithMatchRetry } from '../support/match-retry';

/** Distance-dominant default (§0.1) — used only when `matching.rankingWeights` (§3.8) is unset. */
const DEFAULT_RANKING_WEIGHTS = { distanceWeight: 0.7, priceWeight: 0.3 };

export interface RematchInput {
  matchRequestId: string;
  customerUserId: string;
  /** Same documented gap/decision as `SelectMatchInput.lines` (see that file's doc comment) —
   * needed to re-derive per-line availability/listing choices for the re-ranked pharmacy. */
  lines: Array<{ catalogProductId: string; quantity: number }>;
}

/**
 * `POST /matching/:id/rematch` (module-05 §3.10 `RematchOrchestrator`, §8.3/§8.4, §12 "Rematch",
 * ADR-014). Only legal from `MATCHED` (§3.11 invariant 8) — the "pharmacy declined/unavailable"
 * entry point (BR-MT-04). Order: (1) release the currently-held reservations for the declined
 * pharmacy via `IInventoryPort.release()` (idempotent, Module 04's own transaction, called
 * first per ADR-014); (2) re-rank remaining candidates excluding the declined pharmacy; (3) in
 * one `Serializable` transaction, transition `MATCHED -> REMATCHING` and then, in the same
 * transaction, either re-select (`REMATCHING -> MATCHED`, reserving the new pharmacy's lines
 * first) or exhaust (`REMATCHING -> FAILED`, §3.11 invariant 8's terminal case) — `REMATCHING`
 * is a real, distinct transition step (never collapsed into `MATCHED -> MATCHED`,
 * `match-status-policy.ts`'s own doc comment), even though both steps commit together.
 */
@Injectable()
export class RematchCommand {
  constructor(
    @Inject(MATCH_REPOSITORY) private readonly matches: IMatchRepository,
    @Inject(AVAILABILITY_PORT) private readonly availability: IAvailabilityPort,
    @Inject(INVENTORY_PORT) private readonly inventory: IInventoryPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: RematchInput): Promise<MatchRequestSnapshot> {
    const matchRequest = await this.matches.findById(input.matchRequestId);
    if (!matchRequest || matchRequest.customerUserId !== input.customerUserId) {
      throw PrescriptionMatchingErrors.notFound('Match request not found');
    }
    MatchStatusPolicy.assertValidTransition(matchRequest.status, MatchStatus.REMATCHING);

    const excludedPharmacyId = matchRequest.chosenResult?.pharmacyId ?? null;

    // ADR-014: release the declined pharmacy's holds first (idempotent, self-contained
    // transaction owned by Module 04).
    if (matchRequest.chosenResult) {
      for (const line of matchRequest.chosenResult.lines) {
        await this.inventory.release({ reservationId: line.reservationId, reason: 'rematch' });
      }
    }

    const byPharmacyBranch = new Map<
      string,
      { pharmacyId: string; branchId: string; totalPrice: number; distanceMeters?: number; coveredLines: number }
    >();
    for (const line of input.lines) {
      const rows = await this.availability.getAvailability(line.catalogProductId);
      for (const row of rows) {
        if (excludedPharmacyId && row.pharmacyId === excludedPharmacyId) {
          continue;
        }
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

    if (ranked.length === 0) {
      return runWithMatchRetry(this.uow, async (tx) => {
        const fresh = await this.matches.findById(matchRequest.id, tx);
        if (!fresh) {
          throw PrescriptionMatchingErrors.notFound('Match request not found');
        }
        MatchStatusPolicy.assertValidTransition(fresh.status, MatchStatus.REMATCHING);
        await this.matches.updateStatus(fresh.id, { status: MatchStatus.REMATCHING }, tx);
        MatchStatusPolicy.assertValidTransition(MatchStatus.REMATCHING, MatchStatus.FAILED);
        await this.matches.updateStatus(fresh.id, { status: MatchStatus.FAILED, chosenResult: null }, tx);
        await this.matches.replaceCandidates(fresh.id, [], tx);

        await this.audit.record(
          {
            actorUserId: input.customerUserId,
            action: 'MATCH_FAILED',
            resourceType: 'MatchRequest',
            resourceId: fresh.id,
            context: { excludedPharmacyId },
          },
          tx,
        );
        await this.outbox.write(matchFailedEvent({ matchRequestId: fresh.id }), tx as never);

        return (await this.matches.findById(fresh.id, tx)) as MatchRequestSnapshot;
      });
    }

    const top = ranked[0];
    const chosenLines = [];
    const reservedIds: string[] = [];
    try {
      for (const line of input.lines) {
        const rows = await this.availability.getAvailability(line.catalogProductId);
        const listing = rows.find(
          (a) => a.pharmacyId === top.pharmacyId && a.branchId === top.branchId && a.sellable >= line.quantity,
        );
        if (!listing) {
          throw PrescriptionMatchingErrors.matchCandidateUnavailable();
        }
        const reservation = await this.inventory.reserve({
          listingId: listing.listingId,
          quantity: line.quantity,
          orderId: matchRequest.orderId ?? matchRequest.id,
          idempotencyKey: `rematch:${matchRequest.id}:${listing.listingId}`,
        });
        reservedIds.push(reservation.reservationId);
        chosenLines.push({
          catalogProductId: line.catalogProductId,
          listingId: listing.listingId,
          reservationId: reservation.reservationId,
          quantity: line.quantity,
        });
      }
    } catch (err) {
      await Promise.allSettled(
        reservedIds.map((reservationId) =>
          this.inventory.release({ reservationId, reason: 'rematch-partial-rollback' }),
        ),
      );
      throw err;
    }

    const chosenResult = { pharmacyId: top.pharmacyId, branchId: top.branchId, lines: chosenLines };

    return runWithMatchRetry(this.uow, async (tx) => {
      const fresh = await this.matches.findById(matchRequest.id, tx);
      if (!fresh) {
        throw PrescriptionMatchingErrors.notFound('Match request not found');
      }
      MatchStatusPolicy.assertValidTransition(fresh.status, MatchStatus.REMATCHING);
      await this.matches.updateStatus(fresh.id, { status: MatchStatus.REMATCHING }, tx);
      MatchStatusPolicy.assertValidTransition(MatchStatus.REMATCHING, MatchStatus.MATCHED);
      await this.matches.updateStatus(fresh.id, { status: MatchStatus.MATCHED, chosenResult }, tx);
      await this.matches.replaceCandidates(fresh.id, candidateData, tx);

      await this.audit.record(
        {
          actorUserId: input.customerUserId,
          action: 'MATCH_REMATCHED',
          resourceType: 'MatchRequest',
          resourceId: fresh.id,
          context: { excludedPharmacyId, pharmacyId: top.pharmacyId },
        },
        tx,
      );
      await this.outbox.write(
        rematchTriggeredEvent({ matchRequestId: fresh.id, excludedPharmacyId: excludedPharmacyId ?? '' }),
        tx as never,
      );

      return (await this.matches.findById(fresh.id, tx)) as MatchRequestSnapshot;
    });
  }
}
