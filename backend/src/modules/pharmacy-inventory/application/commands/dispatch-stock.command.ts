import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { ReservationStatus, StockMovementRefType, StockMovementType } from '../../domain/enums';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { stockDispatchedEvent } from '../../domain/events';
import { FefoAllocator } from '../../domain/services/fefo-allocator';
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

/**
 * Dispatch flow (module-04 §8, §12) — FEFO batch decrements. No `DISPATCHED` reservation-status
 * enum value is added (§14.7); the reservation is left `CONFIRMED` and "has this reservation's
 * stock physically left the pharmacy" is answered by `GetReservationFulfillmentQuery` joining to
 * `DISPATCH` movements scoped by `reservationId` (not `orderId` — an order can hold more than
 * one reservation, so `orderId` alone is ambiguous; see the `IReservationRepository
 * .findDispatchMovements` doc comment).
 *
 * Global lock order (module-04 hardening — §8/§12): reservation → listing → affected batches.
 * The reservation's status is re-locked and re-read INSIDE the transaction first, then the
 * listing, so a dispatch racing a concurrent release cannot both "win": the loser sees the
 * now-`RELEASED` status under its own lock and throws `INVALID_RESERVATION_STATE` (dispatch is
 * not idempotent-on-terminal-state — unlike release, attempting to dispatch an already-released
 * reservation is a real caller error, not a safe no-op). The batch rows FEFO-allocates from are
 * then explicitly locked too (`lockBatchesForListing`, after the listing lock, matching
 * `AdjustBatchCommand`'s listing-then-batch order so the two flows cannot deadlock against each
 * other). The dispatch-already-happened check (`findDispatchMovements`, run under the same `tx`)
 * still short-circuits a true retry of the same dispatch.
 */
@Injectable()
export class DispatchStockCommand {
  constructor(
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: IReservationRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: { reservationId: string; actorUserId?: string }): Promise<void> {
    const precheck = await this.reservations.findById(input.reservationId);
    if (!precheck) {
      throw PharmacyInventoryErrors.reservationNotFound();
    }

    await this.uow.run(async (tx) => {
      const reservation = await this.reservations.lockForUpdate(input.reservationId, tx);
      if (!reservation) {
        throw PharmacyInventoryErrors.reservationNotFound();
      }
      if (reservation.status !== ReservationStatus.CONFIRMED) {
        throw PharmacyInventoryErrors.invalidReservationState(reservation.status, 'DISPATCHED');
      }

      const already = await this.reservations.findDispatchMovements(input.reservationId, tx);
      if (already.length > 0) {
        return;
      }

      const listing = await this.listings.lockForUpdate(reservation.listingId, tx);
      if (!listing) {
        throw PharmacyInventoryErrors.listingNotFound();
      }
      const listingProps = listing.toProps();
      const batches = await this.ledger.lockBatchesForListing(reservation.listingId, tx);
      const allocations = FefoAllocator.allocate(
        batches.map((b) => ({ id: b.id, quantity: b.quantity, expiryDate: b.expiryDate })),
        reservation.quantity,
      );

      for (const allocation of allocations) {
        const batch = batches.find((b) => b.id === allocation.batchId);
        if (!batch) continue;
        await this.ledger.adjustBatchQuantity(batch.id, batch.quantity - allocation.qty, tx);
        await this.ledger.recordMovement(
          {
            id: randomUUID(),
            listingId: reservation.listingId,
            batchId: batch.id,
            type: StockMovementType.DISPATCH,
            quantityDelta: -allocation.qty,
            refType: StockMovementRefType.ORDER,
            refId: reservation.orderId,
            reservationId: reservation.id,
            actorUserId: input.actorUserId ?? null,
          },
          tx,
        );
      }

      // No `Math.max(0, ...)` clamp — see the lock-ordering comment above; the reservation lock
      // guarantees no concurrent flow has already decremented `reserved` for this reservation.
      // Underflow would be a real invariant violation, asserted rather than silently floored.
      const newOnHand = listingProps.onHand - reservation.quantity;
      const newReserved = listingProps.reserved - reservation.quantity;
      if (newOnHand < 0 || newReserved < 0) {
        throw PharmacyInventoryErrors.validation(
          'Invariant violation: dispatching this reservation would make onHand/reserved negative.',
          { listingId: reservation.listingId, reservationId: input.reservationId },
        );
      }
      await this.listings.updateCache(
        reservation.listingId,
        { onHand: newOnHand, reserved: newReserved },
        tx,
      );

      await this.outbox.write(
        stockDispatchedEvent({
          listingId: reservation.listingId,
          orderId: reservation.orderId,
          quantity: reservation.quantity,
          batchAllocations: allocations,
        }),
        tx as never,
      );
    });
  }
}
