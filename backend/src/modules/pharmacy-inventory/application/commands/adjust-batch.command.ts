import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { StockMovementRefType, StockMovementType } from '../../domain/enums';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import {
  IStockLedgerRepository,
  STOCK_LEDGER_REPOSITORY,
} from '../../domain/repositories/stock-ledger.repository';
import { SellableStockCalculator } from '../../domain/services/sellable-stock.calculator';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface AdjustBatchInput {
  actorUserId: string;
  pharmacyId: string;
  batchId: string;
  quantityDelta: number;
  reason: string;
}

/**
 * `PATCH /inventory/batches/:id` — `AdjustBatchDto`, reason mandatory (module-04 §5.3, §10.2).
 *
 * The initial `findBatchById`/`listings.findById` reads below are only a cheap pre-check to
 * return `404` fast for a nonexistent batch/wrong-pharmacy request — they are NEVER trusted as
 * the basis for the write. The batch and listing rows are re-locked (`FOR UPDATE`) and re-read
 * INSIDE the transaction, and the new quantity is computed from that locked, fresh snapshot, so
 * two concurrent adjustments to the same batch cannot lose an update or drive quantity/onHand
 * negative.
 *
 * Global lock order (module-04 hardening — §8/§12): **listing → affected batches** for any
 * listing/batch-only flow (this command never touches `reserved`/reservations, so it never
 * participates in the reservation → listing ordering). This used to lock batch-then-listing,
 * which is the exact inverse of `DispatchStockCommand`'s listing-then-batch order and could
 * deadlock in Postgres (adjustment holding the batch row and waiting on the listing, dispatch
 * holding the listing and waiting on the same batch row). Locking the listing first here — and
 * re-validating that the freshly-locked batch still belongs to that listing before computing
 * anything — establishes one global order across every command that touches both a listing and
 * its batches, so no two of them can ever wait on each other in opposite directions.
 */
@Injectable()
export class AdjustBatchCommand {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: AdjustBatchInput): Promise<void> {
    const precheckBatch = await this.ledger.findBatchById(input.batchId);
    if (!precheckBatch) {
      throw PharmacyInventoryErrors.notFound('Batch not found.');
    }
    const precheckListing = await this.listings.findById(precheckBatch.listingId);
    if (!precheckListing || precheckListing.toProps().pharmacyId !== input.pharmacyId) {
      throw PharmacyInventoryErrors.listingNotFound();
    }

    await this.uow.run(async (tx) => {
      const listing = await this.listings.lockForUpdate(precheckListing.id, tx);
      if (!listing || listing.toProps().pharmacyId !== input.pharmacyId) {
        throw PharmacyInventoryErrors.listingNotFound();
      }
      const props = listing.toProps();

      const batch = await this.ledger.lockBatchForUpdate(input.batchId, tx);
      if (!batch || batch.listingId !== listing.id) {
        throw PharmacyInventoryErrors.notFound('Batch not found.');
      }
      const newQuantity = batch.quantity + input.quantityDelta;
      if (newQuantity < 0) {
        throw PharmacyInventoryErrors.validation('Adjustment would make batch quantity negative.', {
          field: 'quantityDelta',
        });
      }

      const newOnHand = props.onHand + input.quantityDelta;
      if (newOnHand < 0) {
        throw PharmacyInventoryErrors.validation('Adjustment would make listing onHand negative.', {
          field: 'quantityDelta',
        });
      }

      await this.ledger.adjustBatchQuantity(input.batchId, newQuantity, tx);
      await this.ledger.recordMovement(
        {
          id: randomUUID(),
          listingId: batch.listingId,
          batchId: input.batchId,
          type: StockMovementType.ADJUST,
          quantityDelta: input.quantityDelta,
          reason: input.reason,
          refType: StockMovementRefType.MANUAL,
          actorUserId: input.actorUserId,
        },
        tx,
      );

      const batches = await this.ledger.findBatchesByListing(batch.listingId, tx);
      const sellable = SellableStockCalculator.computeSellable(
        batches.map((b) => ({ quantity: b.quantity, expiryDate: b.expiryDate })),
        props.reserved,
      );
      await this.listings.updateCache(batch.listingId, { onHand: newOnHand, sellable }, tx);

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'BATCH_ADJUSTED',
          resourceType: 'InventoryListing',
          resourceId: batch.listingId,
          context: { batchId: input.batchId, quantityDelta: input.quantityDelta, reason: input.reason },
        },
        tx,
      );
    });
  }
}
