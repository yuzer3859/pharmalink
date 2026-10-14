import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { expireLapsedHold } from '../../application/services/lapsed-hold-expiry';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import {
  IReservationRepository,
  RESERVATION_REPOSITORY,
} from '../../domain/repositories/reservation.repository';
import {
  IStockLedgerRepository,
  STOCK_LEDGER_REPOSITORY,
} from '../../domain/repositories/stock-ledger.repository';
import { PrismaService } from '../../../../shared/prisma/prisma.service';

/**
 * BR-PH-14/ADR-007 (module-04 §8, hardening pass). Every 1 minute: release each expired `HELD`
 * reservation **in its own transaction**, one row at a time, via a single combined
 * discovery-and-lock query (`lockNextExpired`: `... FOR UPDATE SKIP LOCKED ... LIMIT 1`) that is
 * deliberately the very first statement of that transaction.
 *
 * Why one transaction per reservation (not one transaction for the whole batch, as before):
 *  - All invariants (the `newReserved >= 0` check, in particular) are now calculated and
 *    validated BEFORE any write for that reservation happens — no status/movement/cache/outbox
 *    write is ever issued until every invariant for that row has already passed.
 *  - If a row's invariant fails anyway (a real data-integrity bug elsewhere), it's raised as a
 *    thrown domain error, which rolls back ONLY that row's own transaction — the reservation
 *    stays `HELD`, no movement/cache/outbox change survives — rather than being logged and
 *    `continue`d past while its partial writes (status + movement) still commit as part of a
 *    larger shared transaction. A corrupt row can no longer silently commit a half-applied
 *    expiration, and it can no longer take the rest of a healthy batch down with it either.
 *
 * Why discovery and locking are ONE query (`lockNextExpired`, not a separate unlocked "find
 * candidate ids" pre-scan followed by a per-id lock): an extra network round trip before the
 * lock is attempted would widen the race window against a concurrent manual
 * confirm/release/dispatch on the very same row, changing which side tends to win purely as an
 * artifact of this sweeper's internal plumbing rather than genuine contention. Keeping `FOR
 * UPDATE SKIP LOCKED` as the literal first statement of each per-row transaction reproduces the
 * original single-query batch scan's race characteristics while still giving each row its own
 * atomic, independently-committable transaction. `SKIP LOCKED` means a row currently held by a
 * concurrent flow is simply left for a later tick rather than blocking.
 *
 * Reservation → listing lock order is preserved within each row's transaction.
 */
@Injectable()
export class ReservationTtlSweeper {
  private readonly logger = new AppLogger();
  /** Upper bound on rows processed per tick — mirrors the old batch scan's `LIMIT 200`, just
   * applied across per-row iterations instead of a single multi-row query. */
  private static readonly MAX_PER_TICK = 200;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: IReservationRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
    private readonly outbox: OutboxService,
  ) {
    this.logger.setContext(ReservationTtlSweeper.name);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<number> {
    const now = new Date();
    let processed = 0;
    // Rows that failed an invariant check earlier in this same tick — excluded from subsequent
    // `lockNextExpired` calls so a single permanently-invalid row (always the earliest
    // `expiresAt`) cannot starve every other eligible reservation for the rest of the tick.
    const failedThisTick: string[] = [];

    for (let i = 0; i < ReservationTtlSweeper.MAX_PER_TICK; i += 1) {
      const result = await this.expireNext(now, failedThisTick);
      if (result === 'none-left') {
        break;
      }
      if (result === 'expired') {
        processed += 1;
      } else {
        // 'skipped': an invariant violation was hit and rolled back — recorded so the next
        // iteration moves on to a different candidate instead of retrying this one.
        failedThisTick.push(result.reservationId);
      }
    }

    if (processed > 0) {
      this.logger.log(`Expired ${processed} stale reservations.`);
    }
    return processed;
  }

  /**
   * Locks and expires (at most) one reservation inside its own transaction.
   *  - `'expired'` — this call produced the expiry effect.
   *  - `'none-left'` — no eligible, currently-unlocked candidate remains this tick; the caller's
   *    loop should stop.
   *  - `{ reservationId }` — an invariant violation was hit and rolled back (logged), or the
   *    transaction otherwise failed after a row was already locked; the caller's loop should
   *    keep going (other rows are independent) but exclude this id from future attempts this
   *    tick so it doesn't get re-selected forever as the earliest `expiresAt`.
   * Never throws.
   */
  private async expireNext(
    now: Date,
    excludeIds: string[],
  ): Promise<'expired' | 'none-left' | { reservationId: string }> {
    let lockedReservationId: string | null = null;
    try {
      const handled = await this.prisma.$transaction(
        async (tx) => {
          const reservation = await this.reservations.lockNextExpired(now, excludeIds, tx);
          if (!reservation) {
            return false;
          }
          lockedReservationId = reservation.id;

          // Shared with `ConfirmReservationCommand`, which applies the same effect when it finds
          // a lapsed hold under its own lock: invariants validated before any write, then status,
          // RELEASE movement, listing cache and outbox commit or roll back together.
          await expireLapsedHold(
            { reservations: this.reservations, listings: this.listings, ledger: this.ledger, outbox: this.outbox },
            reservation,
            tx,
          );

          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
      return handled ? 'expired' : 'none-left';
    } catch (err) {
      this.logger.error(
        `Failed to TTL-expire reservation ${lockedReservationId ?? '(unknown)'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // A candidate was locked but its invariant check (or a later write) failed — the
      // transaction rolled back, but there may still be OTHER eligible rows this tick, so the
      // caller's loop should keep going rather than stop as it would for 'none-left'.
      return lockedReservationId ? { reservationId: lockedReservationId } : 'none-left';
    }
  }
}
