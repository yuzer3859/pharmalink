import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { StockMovementRefType, StockMovementType } from '../../domain/enums';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { stockReceivedEvent } from '../../domain/events';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import {
  IStockLedgerRepository,
  STOCK_LEDGER_REPOSITORY,
} from '../../domain/repositories/stock-ledger.repository';
import { SellableStockCalculator } from '../../domain/services/sellable-stock.calculator';
import { BatchNumber } from '../../domain/value-objects/batch-number.vo';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface AddBatchInput {
  actorUserId: string;
  pharmacyId: string;
  listingId: string;
  batchNumber: string;
  quantity: number;
  expiryDate: string;
  supplier?: string;
}

/**
 * `POST /inventory/listings/:id/batches` (module-04 §5.3, §10.2).
 *
 * The initial `listings.findById` read below is only a cheap pre-check to return `404` fast for
 * a nonexistent batch/wrong-pharmacy request — it is NEVER trusted as the basis for the write.
 * The listing row is re-locked (`FOR UPDATE`) and re-read INSIDE the transaction, and the new
 * `onHand`/`sellable` cache values are computed from that locked, fresh snapshot (plus the
 * batches re-read under the same transaction), so two concurrent batch additions — or a batch
 * addition racing reserve/dispatch/adjustment — cannot overwrite each other's cache update
 * (module-04 hardening, mirroring `AdjustBatchCommand`).
 *
 * Global lock order (module-04 hardening — §8/§12): **listing → affected batches**. This command
 * inserts a brand-new batch row (not an existing one), so there is nothing to lock-order against
 * for that insert; locking the listing first before inserting the batch keeps it consistent with
 * `AdjustBatchCommand`/`DispatchStockCommand`'s listing-then-batch order, so none of these flows
 * can ever deadlock against each other.
 */
@Injectable()
export class AddBatchCommand {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: AddBatchInput): Promise<{ batchId: string }> {
    const precheckListing = await this.listings.findById(input.listingId);
    if (!precheckListing || precheckListing.toProps().pharmacyId !== input.pharmacyId) {
      throw PharmacyInventoryErrors.listingNotFound();
    }

    const expiryDate = new Date(input.expiryDate);
    if (Number.isNaN(expiryDate.getTime()) || expiryDate.getTime() <= Date.now()) {
      throw PharmacyInventoryErrors.validation('expiryDate must be a valid future date.', {
        field: 'expiryDate',
      });
    }
    const batchNumber = BatchNumber.of(input.batchNumber);
    const batchId = randomUUID();

    return this.uow.run(async (tx) => {
      const listing = await this.listings.lockForUpdate(input.listingId, tx);
      if (!listing || listing.toProps().pharmacyId !== input.pharmacyId) {
        throw PharmacyInventoryErrors.listingNotFound();
      }
      const props = listing.toProps();

      await this.ledger.addBatch(
        {
          id: batchId,
          listingId: input.listingId,
          batchNumber: batchNumber.value,
          quantity: input.quantity,
          expiryDate,
          supplier: input.supplier ?? null,
          receivedAt: new Date(),
        },
        tx,
      );
      await this.ledger.recordMovement(
        {
          id: randomUUID(),
          listingId: input.listingId,
          batchId,
          type: StockMovementType.RECEIPT,
          quantityDelta: input.quantity,
          refType: StockMovementRefType.MANUAL,
          actorUserId: input.actorUserId,
        },
        tx,
      );

      const batches = await this.ledger.findBatchesByListing(input.listingId, tx);
      const sellable = SellableStockCalculator.computeSellable(
        batches.map((b) => ({ quantity: b.quantity, expiryDate: b.expiryDate })),
        props.reserved,
      );
      await this.listings.updateCache(
        input.listingId,
        { onHand: props.onHand + input.quantity, sellable },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'BATCH_RECEIVED',
          resourceType: 'InventoryListing',
          resourceId: input.listingId,
          context: { batchId, quantity: input.quantity },
        },
        tx,
      );
      await this.outbox.write(
        stockReceivedEvent({
          listingId: input.listingId,
          batchId,
          quantity: input.quantity,
          expiryDate: expiryDate.toISOString(),
        }),
        tx as never,
      );

      return { batchId };
    });
  }
}
