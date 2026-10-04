import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { StorageRequirement, StockMovementRefType } from '../../domain/enums';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { listingCreatedEvent, stockReceivedEvent } from '../../domain/events';
import { InventoryListing } from '../../domain/entities/inventory-listing.entity';
import { BRANCH_REPOSITORY, IBranchRepository } from '../../domain/repositories/branch.repository';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import {
  IStockLedgerRepository,
  STOCK_LEDGER_REPOSITORY,
} from '../../domain/repositories/stock-ledger.repository';
import { TransactingEligibilityPolicy } from '../../domain/services/transacting-eligibility.policy';
import { StockMovementType } from '../../domain/enums';
import { BatchNumber } from '../../domain/value-objects/batch-number.vo';
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface CreateListingInput {
  actorUserId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  price: number;
  currency?: string;
  batchNumber: string;
  initialQuantity: number;
  expiryDate: string;
  supplier?: string;
}

/** `POST /inventory/listings` — create + initial batch atomically (module-04 §5.3, §10.2). */
@Injectable()
export class CreateListingCommand {
  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(BRANCH_REPOSITORY) private readonly branches: IBranchRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: CreateListingInput): Promise<{ listingId: string }> {
    const pharmacy = await this.pharmacies.findById(input.pharmacyId);
    if (!pharmacy) {
      throw PharmacyInventoryErrors.notFound('Pharmacy not found.');
    }
    if (!TransactingEligibilityPolicy.isEligible(pharmacy.toProps())) {
      throw PharmacyInventoryErrors.pharmacyNotEligible();
    }

    const branch = await this.branches.findById(input.branchId);
    if (!branch || branch.pharmacyId !== input.pharmacyId) {
      throw PharmacyInventoryErrors.branchNotFound();
    }

    const product = await this.catalog.getProduct(input.catalogProductId);
    if (!product || product.status !== 'ACTIVE') {
      throw PharmacyInventoryErrors.catalogProductNotFound();
    }
    if (product.onlineSaleProhibited) {
      throw PharmacyInventoryErrors.controlledProhibited();
    }

    const existing = await this.listings.findByBranchAndProduct(input.branchId, input.catalogProductId);
    if (existing) {
      throw PharmacyInventoryErrors.duplicateListing(existing.id);
    }

    const expiryDate = new Date(input.expiryDate);
    if (Number.isNaN(expiryDate.getTime()) || expiryDate.getTime() <= Date.now()) {
      throw PharmacyInventoryErrors.validation('expiryDate must be a valid future date.', {
        field: 'expiryDate',
      });
    }
    const batchNumber = BatchNumber.of(input.batchNumber);

    const listing = InventoryListing.create(randomUUID(), {
      pharmacyId: input.pharmacyId,
      branchId: input.branchId,
      catalogProductId: input.catalogProductId,
      price: input.price,
      currency: input.currency ?? 'ETB',
      storageRequirement: product.storageRequirement as StorageRequirement,
    });
    const batchId = randomUUID();

    try {
      return await this.uow.run(async (tx) => {
        await this.listings.create(listing, tx);
        await this.ledger.addBatch(
          {
            id: batchId,
            listingId: listing.id,
            batchNumber: batchNumber.value,
            quantity: input.initialQuantity,
            expiryDate,
            supplier: input.supplier ?? null,
            receivedAt: new Date(),
          },
          tx,
        );
        await this.ledger.recordMovement(
          {
            id: randomUUID(),
            listingId: listing.id,
            batchId,
            type: StockMovementType.RECEIPT,
            quantityDelta: input.initialQuantity,
            refType: StockMovementRefType.MANUAL,
            actorUserId: input.actorUserId,
          },
          tx,
        );
        await this.listings.updateCache(
          listing.id,
          { onHand: input.initialQuantity, reserved: 0, sellable: input.initialQuantity },
          tx,
        );

        await this.audit.record(
          {
            actorUserId: input.actorUserId,
            action: 'LISTING_CREATED',
            resourceType: 'InventoryListing',
            resourceId: listing.id,
            context: { catalogProductId: input.catalogProductId, branchId: input.branchId },
          },
          tx,
        );

        await this.outbox.write(
          listingCreatedEvent({
            listingId: listing.id,
            catalogProductId: input.catalogProductId,
            branchId: input.branchId,
            pharmacyId: input.pharmacyId,
            price: input.price,
          }),
          tx as never,
        );
        await this.outbox.write(
          stockReceivedEvent({
            listingId: listing.id,
            batchId,
            quantity: input.initialQuantity,
            expiryDate: expiryDate.toISOString(),
          }),
          tx as never,
        );

        return { listingId: listing.id };
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        const dup = await this.listings.findByBranchAndProduct(input.branchId, input.catalogProductId);
        throw PharmacyInventoryErrors.duplicateListing(dup?.id ?? listing.id);
      }
      throw err;
    }
  }
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002');
}
