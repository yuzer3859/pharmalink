import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { listingDisabledEvent } from '../../domain/events';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface DeleteListingInput {
  actorUserId: string;
  pharmacyId: string;
  listingId: string;
}

/** `DELETE /inventory/listings/:id` — soft-delete (module-04 §3.10.8, §10.2). */
@Injectable()
export class DeleteListingCommand {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
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
