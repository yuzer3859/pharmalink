import { randomUUID } from 'crypto';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { StockReservationProps } from '../../domain/entities/stock-reservation.entity';
import { ReservationStatus, StockMovementRefType, StockMovementType } from '../../domain/enums';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { stockReleasedEvent } from '../../domain/events';
import { IListingRepository } from '../../domain/repositories/listing.repository';
import { IReservationRepository } from '../../domain/repositories/reservation.repository';
import { IStockLedgerRepository } from '../../domain/repositories/stock-ledger.repository';
import { SellableStockCalculator } from '../../domain/services/sellable-stock.calculator';

export interface LapsedHoldExpiryDeps {
  reservations: IReservationRepository;
  listings: IListingRepository;
  ledger: IStockLedgerRepository;
  outbox: OutboxService;
}

/**
 * The TTL-expiry effect for one lapsed `HELD` reservation (module-04 §8, BR-PH-14/ADR-007):
 * `HELD -> EXPIRED`, one `RELEASE` movement, the listing's `reserved`/`sellable` cache, and one
 * `stock.released` (`TTL_EXPIRED`) outbox event — all in the caller's transaction.
 *
 * Shared by the two flows that can prove a hold has lapsed while holding its row lock:
 * `ReservationTtlSweeper` and `ConfirmReservationCommand`. The caller MUST already hold the
 * reservation row lock and have re-read it as `HELD` with `expiresAt < now` under that lock — the
 * lock plus that re-read is the guard that makes this effect apply exactly once (a concurrent
 * release/dispatch/confirm/sweep waits on, or SKIP LOCKED-skips, the same row and then sees the
 * terminal status). This function then locks the listing (reservation → listing lock order).
 *
 * Every invariant is validated BEFORE the first write; a violation throws, so the caller's
 * transaction rolls back with nothing applied.
 */
export async function expireLapsedHold(
  deps: LapsedHoldExpiryDeps,
  reservation: StockReservationProps,
  tx: unknown,
): Promise<void> {
  const listing = await deps.listings.lockForUpdate(reservation.listingId, tx);
  if (!listing) {
    throw PharmacyInventoryErrors.listingNotFound();
  }
  const listingProps = listing.toProps();

  // No `Math.max(0, ...)` clamp: the reservation and listing are both locked, so no concurrent
  // release/confirm/dispatch of this same reservation can race this decrement. Underflow would
  // indicate a real invariant violation, so it is thrown rather than floored.
  const newReserved = listingProps.reserved - reservation.quantity;
  if (newReserved < 0) {
    throw PharmacyInventoryErrors.validation(
      'Invariant violation: TTL-expiring this reservation would make listing reserved negative.',
      { listingId: reservation.listingId, reservationId: reservation.id },
    );
  }
  const batches = await deps.ledger.findBatchesByListing(reservation.listingId, tx);
  const sellable = SellableStockCalculator.computeSellable(
    batches.map((b) => ({ quantity: b.quantity, expiryDate: b.expiryDate })),
    newReserved,
  );

  // Only now, with every invariant already validated, do any writes happen.
  await deps.reservations.updateStatus(reservation.id, ReservationStatus.EXPIRED, tx);
  await deps.ledger.recordMovement(
    {
      id: randomUUID(),
      listingId: reservation.listingId,
      type: StockMovementType.RELEASE,
      quantityDelta: reservation.quantity,
      refType: StockMovementRefType.SYSTEM,
      refId: reservation.orderId,
      reservationId: reservation.id,
      reason: 'TTL expiry',
    },
    tx,
  );
  await deps.listings.updateCache(reservation.listingId, { reserved: newReserved, sellable }, tx);
  await deps.outbox.write(
    stockReleasedEvent({
      listingId: reservation.listingId,
      reservationId: reservation.id,
      quantity: reservation.quantity,
      reason: 'TTL_EXPIRED',
    }),
    tx as never,
  );
}
