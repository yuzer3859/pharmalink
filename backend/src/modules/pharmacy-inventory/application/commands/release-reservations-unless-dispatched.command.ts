import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { StockReservationProps } from '../../domain/entities/stock-reservation.entity';
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
 * All-or-nothing release of a set of reservations (module-04 §8; Work 55, customer cancellation
 * vs `MarkReadyCommand`). One transaction, in four phases, and no write before the last:
 *
 *  1. Reservation locks — ids de-duplicated and sorted, each locked `FOR UPDATE` in that order
 *     (two overlapping batches therefore never deadlock).
 *  2. Validation under those locks — a missing id is `RESERVATION_NOT_FOUND`; `RELEASED`/`EXPIRED`
 *     are no-ops, as for `ReleaseReservationCommand`; a `CONFIRMED` reservation with a `DISPATCH`
 *     movement naming it (`findDispatchMovements`, `DispatchStockCommand`'s own guard) rejects the
 *     WHOLE batch (`reservationsDispatched`). Nothing has been written, so nothing is released.
 *  3. Listing locks — the affected listings, sorted, AFTER every reservation lock (reservation →
 *     listing order); per listing, `reserved` must cover the batch's whole quantity, as the single
 *     release asserts per reservation.
 *  4. Writes — per reservation `RELEASED` + one `RELEASE` movement + one `stock.released` outbox
 *     event; per listing one `reserved`/`sellable` cache update. Exactly the single release's
 *     effects, batched.
 *
 * Against dispatch: `DispatchStockCommand` locks the reservation row before writing its `DISPATCH`
 * movements and never holds more than that one reservation lock. If dispatch commits first, phase
 * 2 (Read Committed, after acquiring the lock) sees its movements and rejects; if this batch
 * commits first, dispatch re-reads `RELEASED` under its lock and throws `INVALID_RESERVATION_STATE`.
 * Not audited, like the non-manual single release.
 */
@Injectable()
export class ReleaseReservationsUnlessDispatchedCommand {
  constructor(
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: IReservationRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: { reservationIds: string[]; reason?: string }): Promise<void> {
    const ids = [...new Set(input.reservationIds)].sort();
    if (ids.length === 0) return;

    await this.uow.run(async (tx) => {
      // Phase 1 + 2 — lock every reservation in sorted order, then validate; no write yet.
      const locked: StockReservationProps[] = [];
      for (const id of ids) {
        const reservation = await this.reservations.lockForUpdate(id, tx);
        if (!reservation) throw PharmacyInventoryErrors.reservationNotFound();
        locked.push(reservation);
      }
      const dispatched: string[] = [];
      const toRelease: StockReservationProps[] = [];
      for (const reservation of locked) {
        if (reservation.status === ReservationStatus.RELEASED || reservation.status === ReservationStatus.EXPIRED) {
          continue; // already terminal — a no-op, as for the single release
        }
        if (reservation.status === ReservationStatus.CONFIRMED) {
          if ((await this.reservations.findDispatchMovements(reservation.id, tx)).length > 0) {
            dispatched.push(reservation.id);
            continue;
          }
        }
        toRelease.push(reservation);
      }
      if (dispatched.length > 0) throw PharmacyInventoryErrors.reservationsDispatched(dispatched);
      if (toRelease.length === 0) return;

      // Phase 3 — lock the affected listings (sorted) and validate the counters, still no write.
      const quantityByListing = new Map<string, number>();
      for (const r of toRelease) quantityByListing.set(r.listingId, (quantityByListing.get(r.listingId) ?? 0) + r.quantity);
      const caches: Array<{ listingId: string; reserved: number; sellable: number }> = [];
      for (const listingId of [...quantityByListing.keys()].sort()) {
        const listing = await this.listings.lockForUpdate(listingId, tx);
        if (!listing) throw PharmacyInventoryErrors.listingNotFound();
        const newReserved = listing.toProps().reserved - (quantityByListing.get(listingId) as number);
        if (newReserved < 0) {
          throw PharmacyInventoryErrors.validation(
            'Invariant violation: releasing these reservations would make reserved negative.',
            { listingId },
          );
        }
        const batches = await this.ledger.findBatchesByListing(listingId, tx);
        const sellable = SellableStockCalculator.computeSellable(
          batches.map((b) => ({ quantity: b.quantity, expiryDate: b.expiryDate })),
          newReserved,
        );
        caches.push({ listingId, reserved: newReserved, sellable });
      }

      // Phase 4 — every check passed: the single release's writes, for the whole batch.
      for (const reservation of toRelease) {
        await this.reservations.updateStatus(reservation.id, ReservationStatus.RELEASED, tx);
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
        await this.outbox.write(
          stockReleasedEvent({
            listingId: reservation.listingId,
            reservationId: reservation.id,
            quantity: reservation.quantity,
            reason: input.reason ?? null,
          }),
          tx as never,
        );
      }
      for (const c of caches) {
        await this.listings.updateCache(c.listingId, { reserved: c.reserved, sellable: c.sellable }, tx);
      }
    });
  }
}
