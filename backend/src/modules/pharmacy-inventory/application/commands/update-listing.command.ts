import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { listingDisabledEvent, priceChangedEvent } from '../../domain/events';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import { TransactingEligibilityPolicy } from '../../domain/services/transacting-eligibility.policy';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface UpdateListingInput {
  actorUserId: string;
  pharmacyId: string;
  listingId: string;
  price?: number;
  isEnabled?: boolean;
}

/** `PATCH /inventory/listings/:id` — price/enable (module-04 §5.3, §10.2). */
@Injectable()
export class UpdateListingCommand {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: UpdateListingInput): Promise<void> {
    const listing = await this.listings.findById(input.listingId);
    if (!listing || listing.toProps().pharmacyId !== input.pharmacyId) {
      throw PharmacyInventoryErrors.listingNotFound();
    }
    const props = listing.toProps();

    if (input.isEnabled === true) {
      const pharmacy = await this.pharmacies.findById(input.pharmacyId);
      if (!pharmacy || !TransactingEligibilityPolicy.isEligible(pharmacy.toProps())) {
        throw PharmacyInventoryErrors.pharmacyNotEligible();
      }
    }

    await this.uow.run(async (tx) => {
      await this.listings.updatePriceEnable(
        input.listingId,
        { price: input.price, isEnabled: input.isEnabled },
        tx,
      );

      if (input.price !== undefined && input.price !== props.price) {
        await this.audit.record(
          {
            actorUserId: input.actorUserId,
            action: 'LISTING_PRICE_CHANGED',
            resourceType: 'InventoryListing',
            resourceId: input.listingId,
            context: { oldPrice: props.price, newPrice: input.price },
          },
          tx,
        );
        await this.outbox.write(
          priceChangedEvent({ listingId: input.listingId, oldPrice: props.price, newPrice: input.price }),
          tx as never,
        );
      }

      if (input.isEnabled === false && props.isEnabled) {
        await this.audit.record(
          {
            actorUserId: input.actorUserId,
            action: 'LISTING_DISABLED',
            resourceType: 'InventoryListing',
            resourceId: input.listingId,
          },
          tx,
        );
        await this.outbox.write(listingDisabledEvent({ listingId: input.listingId }), tx as never);
      }

      if (input.isEnabled === true && !props.isEnabled) {
        await this.audit.record(
          {
            actorUserId: input.actorUserId,
            action: 'LISTING_ENABLED',
            resourceType: 'InventoryListing',
            resourceId: input.listingId,
          },
          tx,
        );
      }
    });
  }
}
