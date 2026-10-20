import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { listingDisabledEvent } from '../../domain/events';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import { IReservationRepository, RESERVATION_REPOSITORY } from '../../domain/repositories/reservation.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface DeleteListingInput {
  actorUserId: string;
  pharmacyId: string;
  listingId: string;
}

/**
 * `DELETE /inventory/listings/:id` — soft-delete (module-04 §3.10.8, §10.2).
 *
 * Refused (409 `CONFLICT`) while any reservation may still need the listing (Work 55, H1): release,
 * TTL expiry, dispatch and the cancellation batch all lock the listing via `lockForUpdate`, which
 * skips soft-deleted rows — deleting it under a live reservation would strand that stock and block
 * the order's cancellation for good. Race-free: the check runs in the deleting transaction AFTER
 * taking the listing's row lock — the same lock `ReserveStockCommand` takes before creating a
 * reservation, so no reservation can appear between the check and the delete (a reserve waiting on
 * the lock then finds the listing deleted). This command takes no reservation lock, so it can wait
 * on nobody holding the reservation → listing order: an in-flight release/dispatch blocked on the
 * listing lock still reads as live here, which only makes the answer conservative.
 */
@Injectable()
export class DeleteListingCommand {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: IReservationRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: DeleteListingInput): Promise<void> {
    const listing = await this.listings.findById(input.listingId);
    if (!listing || listing.toProps().pharmacyId !== input.pharmacyId) {
      throw PharmacyInventoryErrors.listingNotFound();
    }

    await this.uow.run(async (tx) => {
      if (!(await this.listings.lockForUpdate(input.listingId, tx))) {
        throw PharmacyInventoryErrors.listingNotFound(); // deleted concurrently
      }
      const live = await this.reservations.countLiveForListing(input.listingId, tx);
      if (live > 0) {
        throw PharmacyInventoryErrors.listingHasLiveReservations(live);
      }
      await this.listings.softDelete(input.listingId, tx);
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'LISTING_DELETED',
          resourceType: 'InventoryListing',
          resourceId: input.listingId,
        },
        tx,
      );
      await this.outbox.write(listingDisabledEvent({ listingId: input.listingId }), tx as never);
    });
  }
}
