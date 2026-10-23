import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { ReservationStatus, StockMovementRefType, StockMovementType } from '../../domain/enums';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { stockReleasedEvent } from '../../domain/events';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import {
  IReservationRepository,
  RESERVATION_REPOSITORY,
} from '../../domain/repositories/reservation.repository';
import {
  IStockLedgerRepository,
  STOCK_LEDGER_REPOSITORY,
} from '../../domain/repositories/stock-ledger.repository';
import { SellableStockCalculator } from '../../domain/services/sellable-stock.calculator';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

/**
 * Release flow (module-04 §8, §12). Idempotent — a repeat release of an already-
 * released/expired reservation is a no-op, not an error (§10.3, §15 — safe for saga
 * compensation retries). Releasing a `CONFIRMED` reservation that has already been dispatched
 * (`DISPATCH` movements carry its `reservationId`) is NOT idempotent — it throws
 * `INVALID_RESERVATION_STATE`, since dispatch already consumed its `reserved` share.
 *
 * The initial `findById` below is only a cheap existence pre-check for the 404 case — it is
 * NEVER trusted as authoritative for the mutation decision. The reservation row is re-locked
 * (`lockForUpdate`) and its status re-read INSIDE the transaction (lock order: reservation, then
 * listing — see the comment on `IReservationRepository`), so two concurrent releases (or a
 * manual release racing TTL expiration) cannot both apply the release effect: whichever
 * transaction acquires the row lock first sees `HELD`/`CONFIRMED` and proceeds; the other, after
 * waiting for the lock, re-reads the now-terminal status and short-circuits as a no-op.
 */
@Injectable()
export class ReleaseReservationCommand {
  constructor(
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: IReservationRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: {
    reservationId: string;
    reason?: string;
    actorUserId?: string;
    manual?: boolean;
    statusOnRelease?: typeof ReservationStatus.RELEASED | typeof ReservationStatus.EXPIRED;
  }): Promise<void> {
    const precheck = await this.reservations.findById(input.reservationId);
    if (!precheck) {
      throw PharmacyInventoryErrors.reservationNotFound();
    }

    const targetStatus = input.statusOnRelease ?? ReservationStatus.RELEASED;

    await this.uow.run(async (tx) => {
      const reservation = await this.reservations.lockForUpdate(input.reservationId, tx);
      if (!reservation) {
        throw PharmacyInventoryErrors.reservationNotFound();
      }
      if (
        reservation.status === ReservationStatus.RELEASED ||
        reservation.status === ReservationStatus.EXPIRED
      ) {
        // Already terminal — another transaction (manual release or TTL sweep) won the race and
        // already committed. True no-op: no second movement/outbox/audit row.
        return;
      }
      if (reservation.status === ReservationStatus.CONFIRMED) {
        // Dispatch leaves the reservation `CONFIRMED` (§14.7) but has already subtracted its
        // quantity from `reserved` and `onHand`; releasing it would subtract `reserved` a second
        // time and record a RELEASE for stock that has physically left. Unlike a repeat release,
        // this is a real caller error (e.g. a cancel racing `MarkReadyCommand`'s dispatch), so it
        // is rejected rather than silently skipped. Checked under the reservation lock (which
        // `DispatchStockCommand` also holds while writing its `DISPATCH` movements) and before
        // the listing lock, preserving the reservation → listing order.
        const dispatched = await this.reservations.findDispatchMovements(input.reservationId, tx);
        if (dispatched.length > 0) {
          throw PharmacyInventoryErrors.invalidReservationState('DISPATCHED', targetStatus);
        }
      }

      const listing = await this.listings.lockForUpdate(reservation.listingId, tx);
      if (!listing) {
        throw PharmacyInventoryErrors.listingNotFound();
      }
      const listingProps = listing.toProps();

      // No `Math.max(0, ...)` clamp — the reservation row lock (taken above, before this read of
      // `listingProps.reserved`) guarantees no concurrent release/confirm/dispatch/TTL-expiry of
      // *this same reservation* can have already decremented `reserved` for it; underflow here
      // would indicate a real invariant violation, so it is asserted (before any writes happen)
      // rather than silently floored.
      const newReserved = listingProps.reserved - reservation.quantity;
      if (newReserved < 0) {
        throw PharmacyInventoryErrors.validation(
          'Invariant violation: releasing this reservation would make reserved negative.',
          { listingId: reservation.listingId, reservationId: input.reservationId },
        );
      }

      await this.reservations.updateStatus(input.reservationId, targetStatus, tx);
      await this.ledger.recordMovement(
        {
          id: randomUUID(),
          listingId: reservation.listingId,
          type: StockMovementType.RELEASE,
          quantityDelta: reservation.quantity,
          refType: StockMovementRefType.ORDER,
          refId: reservation.orderId,
          reservationId: reservation.id,
          reason: input.reason ?? null,
        },
        tx,
      );

      const batches = await this.ledger.findBatchesByListing(reservation.listingId, tx);
      const sellable = SellableStockCalculator.computeSellable(
        batches.map((b) => ({ quantity: b.quantity, expiryDate: b.expiryDate })),
        newReserved,
      );
      await this.listings.updateCache(reservation.listingId, { reserved: newReserved, sellable }, tx);

      if (input.manual) {
        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? null,
            action: 'RESERVATION_RELEASED',
            resourceType: 'StockReservation',
            resourceId: input.reservationId,
            context: { reason: input.reason ?? null },
          },
          tx,
        );
      }

      await this.outbox.write(
        stockReleasedEvent({
          listingId: reservation.listingId,
          reservationId: input.reservationId,
          quantity: reservation.quantity,
          reason: input.reason ?? null,
        }),
        tx as never,
      );
    });
  }
}
