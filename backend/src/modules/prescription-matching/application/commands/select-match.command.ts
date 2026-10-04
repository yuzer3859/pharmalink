import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { MatchStatus } from '../../domain/enums';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import { orderMatchedEvent } from '../../domain/events';
import {
  ChosenResult,
  ChosenResultLine,
  IMatchRepository,
  MATCH_REPOSITORY,
  MatchRequestSnapshot,
} from '../../domain/repositories/match.repository';
import { MatchStatusPolicy } from '../../domain/services/match-status-policy';
import { AVAILABILITY_PORT, IAvailabilityPort } from '../ports/outbound/availability.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithMatchRetry } from '../support/match-retry';

export interface SelectMatchInput {
  matchRequestId: string;
  customerUserId: string;
  /** Omitted = accept rank #1 (§5.5). */
  pharmacyId?: string;
  /**
   * **Deviation from §5.5's literal `SelectMatchDto` (flagged, not silently guessed):** the
   * spec's HTTP DTO is just `{ pharmacyId? }`, but `match_candidates` (schema) and
   * `MatchCandidateSnapshot` (domain contract) persist only the aggregate ranking snapshot
   * (`pharmacyId`, `branchId`, `totalPrice`, `distanceMeters`, `rank`) — there is no per-line
   * `catalogProductId`/`listingId`/`quantity` breakdown stored anywhere between `FindMatchCommand`
   * and this command (no Json column on `MatchCandidate`, no `lines` column on `MatchRequest`).
   * Building `ChosenResult.lines` (§3.6) and calling `IInventoryPort.reserve()` per line
   * therefore needs the original requested lines again — supplied here as an explicit
   * command-input field. In the future, once Module 06 (Orders) exists, its caller already has
   * this from its own order/cart, so this is not a schema change on this module's side; it is a
   * narrow, documented application-layer decision, not a repository/domain contract change.
   */
  lines: Array<{ catalogProductId: string; quantity: number }>;
}

/**
 * `POST /matching/:id/select` (module-05 §8.3, §12 "Select match", ADR-014). Two-transaction
 * seam (ADR-014): `IInventoryPort.reserve()` is called and awaited successfully for **every**
 * line **before** this module's own `MatchRequest.status -> MATCHED` update — so the only
 * possible orphan is "reservation(s) succeeded, but the `MatchRequest` update then fails", which
 * self-heals via Module 04's reservation TTL sweeper (ADR-007) reclaiming the unconfirmed `HELD`
 * reservation(s). If a reserve call fails partway through a multi-line selection, the
 * already-succeeded reservations for this same attempt are released as a best-effort
 * compensation (not required for correctness — the TTL sweeper would reclaim them regardless —
 * but avoids holding stock unnecessarily long).
 */
@Injectable()
export class SelectMatchCommand {
  constructor(
    @Inject(MATCH_REPOSITORY) private readonly matches: IMatchRepository,
    @Inject(AVAILABILITY_PORT) private readonly availability: IAvailabilityPort,
    @Inject(INVENTORY_PORT) private readonly inventory: IInventoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: SelectMatchInput): Promise<MatchRequestSnapshot> {
    const matchRequest = await this.matches.findById(input.matchRequestId);
    if (!matchRequest || matchRequest.customerUserId !== input.customerUserId) {
      throw PrescriptionMatchingErrors.notFound('Match request not found');
    }
    MatchStatusPolicy.assertValidTransition(matchRequest.status, MatchStatus.MATCHED);

    const candidates = await this.matches.listCandidates(matchRequest.id);
    const chosen = input.pharmacyId
      ? candidates.find((c) => c.pharmacyId === input.pharmacyId)
      : [...candidates].sort((a, b) => a.rank - b.rank)[0];

    if (!chosen) {
      throw candidates.length === 0
        ? PrescriptionMatchingErrors.noPharmacyMatch()
        : PrescriptionMatchingErrors.matchCandidateUnavailable();
    }

    const chosenResult = await this.reserveChosenLines(matchRequest, chosen.pharmacyId, chosen.branchId, input.lines);

    return runWithMatchRetry(this.uow, async (tx) => {
      const fresh = await this.matches.findById(matchRequest.id, tx);
      if (!fresh) {
        throw PrescriptionMatchingErrors.notFound('Match request not found');
      }
      MatchStatusPolicy.assertValidTransition(fresh.status, MatchStatus.MATCHED);

      await this.matches.updateStatus(
        fresh.id,
        { status: MatchStatus.MATCHED, chosenResult, overridePharmacyId: input.pharmacyId ?? null },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.customerUserId,
          action: 'MATCH_SELECTED',
          resourceType: 'MatchRequest',
          resourceId: fresh.id,
          context: { pharmacyId: chosenResult.pharmacyId, override: Boolean(input.pharmacyId) },
        },
        tx,
      );

      await this.outbox.write(
        orderMatchedEvent({ matchRequestId: fresh.id, orderId: fresh.orderId, result: chosenResult }),
        tx as never,
      );

      return (await this.matches.findById(fresh.id, tx)) as MatchRequestSnapshot;
    });
  }

  /**
   * Resolves a `listingId` per requested line against the chosen pharmacy/branch's live
   * availability and reserves it via Module 04's `IInventoryPort` (§2.1 — injected directly, not
   * re-wrapped in a Module 05 port). Runs entirely **before** this module's own transaction
   * (ADR-014 ordering).
   */
  private async reserveChosenLines(
    matchRequest: MatchRequestSnapshot,
    pharmacyId: string,
    branchId: string,
    lines: Array<{ catalogProductId: string; quantity: number }>,
  ): Promise<ChosenResult> {
    const resolved: ChosenResultLine[] = [];
    const reservedIds: string[] = [];

    try {
      for (const line of lines) {
        const availability = await this.availability.getAvailability(line.catalogProductId);
        const listing = availability.find(
          (a) => a.pharmacyId === pharmacyId && a.branchId === branchId && a.sellable >= line.quantity,
        );
        if (!listing) {
          throw PrescriptionMatchingErrors.matchCandidateUnavailable();
        }

        const reservation = await this.inventory.reserve({
          listingId: listing.listingId,
          quantity: line.quantity,
          orderId: matchRequest.orderId ?? matchRequest.id,
          idempotencyKey: `match:${matchRequest.id}:${listing.listingId}`,
        });
        reservedIds.push(reservation.reservationId);
        resolved.push({
          catalogProductId: line.catalogProductId,
          listingId: listing.listingId,
          reservationId: reservation.reservationId,
          quantity: line.quantity,
        });
      }
    } catch (err) {
      await Promise.allSettled(
        reservedIds.map((reservationId) =>
          this.inventory.release({ reservationId, reason: 'select-match-partial-rollback' }),
        ),
      );
      throw err;
    }

    return { pharmacyId, branchId, lines: resolved };
  }
}
