import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { ReservationStatus } from '../../domain/enums';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import {
  IReservationRepository,
  RESERVATION_REPOSITORY,
} from '../../domain/repositories/reservation.repository';
import {
  IStockLedgerRepository,
  STOCK_LEDGER_REPOSITORY,
} from '../../domain/repositories/stock-ledger.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';
import { expireLapsedHold } from '../services/lapsed-hold-expiry';

/**
 * Confirm flow (module-04 §8, §12) — `HELD -> CONFIRMED`, no quantity change (stock was already
 * decremented from `sellable` at reserve time). No new `stock_movements` row.
 *
 * Confirm is NOT idempotent-on-terminal-state the way release is: confirming an
 * already-`RELEASED`/`EXPIRED` reservation (e.g. it lost a race against TTL expiry) is a real
 * error, not a no-op — the caller (Module 06's payment-success handler) needs to know the
 * reservation is gone so it can compensate, not believe it silently succeeded. The status is
 * re-locked and re-read INSIDE the transaction (never trusting the pre-transaction `findById`)
 * so confirm-vs-expire cannot both "win": whichever transaction locks the row first and commits
 * establishes the terminal state; the other sees that state under its own lock and throws.
 *
 * A lapsed hold found under confirm's own lock is expired HERE, in the same transaction, before
 * `RESERVATION_EXPIRED` is raised (module-04 Work 53). Otherwise it would stay `HELD` — still
 * counted in the listing's `reserved` — whenever the TTL sweeper's `FOR UPDATE SKIP LOCKED`
 * scan reached the row while confirm held it, until some later tick. Only past the sweeper's own
 * strict boundary (`expiresAt < now`); a hold at exactly `expiresAt == now` is still rejected
 * (confirm's `<=`) and left to the sweeper, so neither boundary moves. The expiry effect is the
 * sweeper's (`expireLapsedHold`), and the error is thrown only AFTER that transaction commits,
 * so the rejection never rolls the cleanup back.
 */
@Injectable()
export class ConfirmReservationCommand {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: IReservationRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {
    this.logger.setContext(ConfirmReservationCommand.name);
  }

  async execute(input: { reservationId: string; actorUserId?: string; manual?: boolean }): Promise<void> {
    const precheck = await this.reservations.findById(input.reservationId);
    if (!precheck) {
      throw PharmacyInventoryErrors.reservationNotFound();
    }

    // Set only under the row lock, once the hold is known to have lapsed.
    let lapsed = false;
    try {
      await this.uow.run(async (tx) => {
        const reservation = await this.reservations.lockForUpdate(input.reservationId, tx);
        if (!reservation) {
          throw PharmacyInventoryErrors.reservationNotFound();
        }
        if (reservation.status === ReservationStatus.CONFIRMED) {
          return;
        }
        if (reservation.status !== ReservationStatus.HELD) {
          throw PharmacyInventoryErrors.invalidReservationState(
            reservation.status,
            ReservationStatus.CONFIRMED,
          );
        }
        const now = Date.now();
        if (reservation.expiresAt.getTime() <= now) {
          lapsed = true;
          if (reservation.expiresAt.getTime() < now) {
            await expireLapsedHold(
              { reservations: this.reservations, listings: this.listings, ledger: this.ledger, outbox: this.outbox },
              reservation,
              tx,
            );
          }
          return;
        }

        await this.reservations.updateStatus(input.reservationId, ReservationStatus.CONFIRMED, tx);
        if (input.manual) {
          await this.audit.record(
            {
              actorUserId: input.actorUserId ?? null,
              action: 'RESERVATION_CONFIRMED',
              resourceType: 'StockReservation',
              resourceId: input.reservationId,
            },
            tx,
          );
        }
      });
    } catch (err) {
      if (!lapsed) {
        throw err;
      }
      // The expiry rolled back (an invariant violation or a write failure): the hold is still
      // `HELD` and unchanged, so the sweeper retries it. The caller still learns it has expired.
      this.logger.error(
        `Failed to expire lapsed reservation ${input.reservationId} on confirm: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (lapsed) {
      throw PharmacyInventoryErrors.reservationExpired();
    }
  }
}
