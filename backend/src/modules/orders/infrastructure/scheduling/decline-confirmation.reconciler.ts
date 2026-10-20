import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { IInventoryPort, INVENTORY_PORT } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import {
  IReservationStatusReadPort,
  RESERVATION_STATUS_READ_PORT,
} from '../../../pharmacy-inventory/application/ports/inbound/reservation-status-read.port';
import { classifyCandidates } from '../../application/services/decline-recovery-read.service';
import { DECLINE_RECOVERY_REPOSITORY, IDeclineRecoveryRepository } from '../../domain/repositories/decline-recovery.repository';

/** This worker's `SchedulerRegistry` key. */
export const DECLINE_CONFIRMATION_RECONCILE_CRON = 'orders.decline-confirmation-reconcile';
/** Candidate orders examined per run. */
export const DECLINE_CONFIRMATION_RECONCILE_BATCH_SIZE = 50;

/** Safe, id-free counters for one run. */
export interface DeclineConfirmationReconcileReport {
  examinedOrders: number;
  confirmed: number;
  alreadyConfirmed: number;
  /** RELEASED/EXPIRED/inconsistent replacements — left for an operator (Module 16 view). */
  failed: number;
  /** Lines still on a cancelled fulfillment (decline stopped before Phase 3a) — never touched here. */
  orphaned: number;
  /** The order stopped being a candidate (or the line changed) between the read and the confirm. */
  skipped: number;
  /** A confirm or a read failed for another reason; retried next run. */
  errors: number;
}

const empty = (): DeclineConfirmationReconcileReport => ({
  examinedOrders: 0, confirmed: 0, alreadyConfirmed: 0, failed: 0, orphaned: 0, skipped: 0, errors: 0,
});

/**
 * Completes pharmacy-decline confirmations (Work 55), in the shape of Work 45's reconciler. A decline's
 * Phase 3a commits the new fulfillment and re-points the order lines to replacement reservations that
 * are still `HELD`; the decline then confirms them (Module 04). If the process stopped in between, or
 * every confirm attempt failed, the holds would TTL-expire under a paid order. Every minute — well
 * inside the 15-minute default hold — this worker:
 *
 *  1. reads a bounded, keyset-paged set of candidate orders from Module 06's own rows (live, declined at
 *     least once, no non-rejected customer cancellation request);
 *  2. reads their reservations through Module 04's narrow status port and classifies each line
 *     (`classifyDeclineOrder`) — only a PROVEN post-Phase-3a replacement that is still `HELD` qualifies;
 *  3. re-reads that order just before confirming and requires the same line → fulfillment → reservation
 *     to still be a candidate segment, then calls Module 04's `confirm`.
 *
 * It never re-matches, re-points a line, creates a fulfillment, revives a released/expired reservation
 * or takes a new hold; lines still on a cancelled fulfillment (pre-Phase-3a) are only counted. `confirm`
 * locks the reservation row: against a concurrent cancellation (whose batch release locks the same rows)
 * either the release wins — `confirm` then refuses the `RELEASED` reservation — or the confirm wins and
 * the cancellation, which reads the order's lines, releases the `CONFIRMED` reservation. `confirm` of an
 * already-`CONFIRMED` reservation is a no-op, so overlapping runs are harmless; `confirm` writes no stock
 * movement. `run()` never throws; a run that starts while one is in progress in this process returns.
 */
@Injectable()
export class DeclineConfirmationReconciler {
  private readonly logger = new AppLogger();
  private cursor: string | null = null;
  private running = false;

  constructor(
    @Inject(DECLINE_RECOVERY_REPOSITORY) private readonly candidates: IDeclineRecoveryRepository,
    @Inject(RESERVATION_STATUS_READ_PORT) private readonly reservations: IReservationStatusReadPort,
    @Inject(INVENTORY_PORT) private readonly inventory: IInventoryPort,
  ) {
    this.logger.setContext(DeclineConfirmationReconciler.name);
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: DECLINE_CONFIRMATION_RECONCILE_CRON })
  async run(batchSize = DECLINE_CONFIRMATION_RECONCILE_BATCH_SIZE): Promise<DeclineConfirmationReconcileReport> {
    const report = empty();
    if (this.running) return report;
    this.running = true;
    try {
      let page;
      let segments;
      try {
        page = await this.candidates.listCandidates(this.cursor, batchSize);
        if (page.length === 0 && this.cursor !== null) {
          this.cursor = null;
          page = await this.candidates.listCandidates(null, batchSize);
        }
        segments = await classifyCandidates(page, this.reservations);
      } catch (err) {
        report.errors += 1;
        this.logger.error({ message: 'Decline confirmation reconciliation failed to read a batch; it will be retried', error: errorText(err) });
        return report;
      }
      this.cursor = page.length === batchSize ? page[page.length - 1].id : null;
      report.examinedOrders = page.length;

      for (const s of segments) {
        if (s.state === 'ORPHANED') {
          report.orphaned += 1;
        } else if (s.state === 'RESOLVED') {
          report.alreadyConfirmed += 1;
        } else if (s.state === 'CONFIRMATION_FAILED') {
          report.failed += 1;
          this.logger.error({ message: 'Decline replacement cannot be confirmed; needs an operator', orderId: s.orderId, lineId: s.lineId, reservationId: s.reservationId, diagnosticCode: s.diagnosticCode });
        } else {
          await this.confirmOne(s.orderId, s.lineId, s.fulfillmentId as string, s.reservationId as string, report);
        }
      }
      if (report.confirmed + report.failed + report.orphaned + report.skipped + report.errors > 0) {
        this.logger.log({ message: 'Decline confirmation reconciliation run', ...report });
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  private async confirmOne(orderId: string, lineId: string, fulfillmentId: string, reservationId: string, report: DeclineConfirmationReconcileReport): Promise<void> {
    try {
      // Re-check just before acting: still a candidate, and the same line → fulfillment → reservation
      // still classifies as a proven, confirmable replacement.
      const fresh = await this.candidates.findCandidate(orderId);
      const again = fresh ? await classifyCandidates([fresh], this.reservations) : [];
      const still = again.find((s) => s.lineId === lineId);
      if (!still || still.state !== 'PENDING_CONFIRMATION' || still.fulfillmentId !== fulfillmentId || still.reservationId !== reservationId) {
        report.skipped += 1;
        return;
      }
      await this.inventory.confirm({ reservationId });
      report.confirmed += 1;
    } catch (err) {
      if (err instanceof ApiException && (err.code === ErrorCode.INVALID_RESERVATION_STATE || err.code === ErrorCode.RESERVATION_EXPIRED)) {
        // Released by a concurrent cancellation, or lapsed: never revived. The view shows it if the
        // order is still live; a cancellation removes the order from the candidates.
        report.failed += 1;
        this.logger.error({ message: 'Decline replacement could not be confirmed', orderId, lineId, reservationId, errorCode: err.code });
        return;
      }
      report.errors += 1;
      this.logger.error({ message: 'Decline confirmation failed for one reservation; it will be retried', orderId, reservationId, error: errorText(err) });
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
