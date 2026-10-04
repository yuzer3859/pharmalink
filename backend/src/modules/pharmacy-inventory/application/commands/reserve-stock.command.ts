import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { StockMovementRefType, StockMovementType } from '../../domain/enums';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { stockReservedEvent } from '../../domain/events';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import {
  IReservationRepository,
  RESERVATION_REPOSITORY,
} from '../../domain/repositories/reservation.repository';
import {
  IStockLedgerRepository,
  STOCK_LEDGER_REPOSITORY,
} from '../../domain/repositories/stock-ledger.repository';
import { SellableStockCalculator } from '../../domain/services/sellable-stock.calculator';
import { TransactingEligibilityPolicy } from '../../domain/services/transacting-eligibility.policy';
import { ReserveStockInput, ReserveStockResult } from '../ports/inbound/inventory.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

/**
 * Reserve flow (module-04 §8) — the correctness-critical operation of this slice. Single DB
 * transaction, `Read Committed` isolation (the `IUnitOfWork` impl): row-lock the listing,
 * defensively re-check eligibility, recompute `sellable` fresh under the lock, then insert the
 * reservation — no oversell possible under concurrency (§8's "no oversell guarantee").
 *
 * Idempotency (§5.4/§8/§15): the client-supplied `idempotencyKey` is looked up INSIDE the
 * transaction, under the same listing row lock as the rest of reserve (never as a pre-transaction
 * check — that would be racy under concurrency: two requests with the same key could both pass a
 * pre-check before either has written anything). Three outcomes:
 *  - No existing row for this `(listingId, idempotencyKey)` → proceed to insert. The DB's unique
 *    constraint on `(listingId, idempotencyKey)` is the actual race-safety mechanism: if a
 *    concurrent request wins the insert first, this transaction's insert raises Prisma `P2002`,
 *    which is caught below and resolved by re-reading the winning row (still under the outer
 *    listing lock) rather than assumed to be identical.
 *  - Existing row with an identical payload (`orderId`, `quantity`) → this is a genuine replay;
 *    return the original reservation without writing a second reservation, movement, or outbox
 *    event.
 *  - Existing row with a materially different payload → the same key was reused for a different
 *    logical operation; throw a deterministic `IDEMPOTENCY_CONFLICT` rather than silently
 *    returning the mismatched reservation.
 */
@Injectable()
export class ReserveStockCommand {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: IReservationRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: ReserveStockInput): Promise<ReserveStockResult> {
    const ttlMinutes = Number(this.config.get<number>('inventory.reservationTtlMinutes') ?? 15);

    try {
      return await this.uow.run(async (tx) => {
        const listing = await this.listings.lockForUpdate(input.listingId, tx);
        if (!listing) {
          throw PharmacyInventoryErrors.listingNotFound();
        }
        const listingProps = listing.toProps();

        const existing = await this.reservations.findByIdempotencyKey(
          input.listingId,
          input.idempotencyKey,
          tx,
        );
        if (existing) {
          return assertReplayOrConflict(existing, input);
        }

        const pharmacy = await this.pharmacies.findById(listingProps.pharmacyId, tx);
        if (!pharmacy || !TransactingEligibilityPolicy.isEligible(pharmacy.toProps())) {
          throw PharmacyInventoryErrors.pharmacyNotEligible();
        }

        const now = new Date();
        const batches = await this.ledger.findBatchesByListing(input.listingId, tx);
        const sellable = SellableStockCalculator.computeSellable(
          batches.map((b) => ({ quantity: b.quantity, expiryDate: b.expiryDate })),
          listingProps.reserved,
          now,
        );
        if (sellable < input.quantity) {
          throw PharmacyInventoryErrors.insufficientStock(sellable);
        }

        const reservationId = randomUUID();
        const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

        await this.reservations.create(
          {
            id: reservationId,
            listingId: input.listingId,
            orderId: input.orderId,
            quantity: input.quantity,
            expiresAt,
            idempotencyKey: input.idempotencyKey,
          },
          tx,
        );
        await this.ledger.recordMovement(
          {
            id: randomUUID(),
            listingId: input.listingId,
            type: StockMovementType.RESERVE,
            quantityDelta: -input.quantity,
            refType: StockMovementRefType.ORDER,
            refId: input.orderId,
            reservationId,
            reason: `idempotencyKey=${input.idempotencyKey}`,
          },
          tx,
        );
        await this.listings.updateCache(
          input.listingId,
          { reserved: listingProps.reserved + input.quantity, sellable: sellable - input.quantity },
          tx,
        );

        await this.outbox.write(
          stockReservedEvent({
            listingId: input.listingId,
            reservationId,
            orderId: input.orderId,
            quantity: input.quantity,
          }),
          tx as never,
        );

        return { reservationId, expiresAt };
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        // Lost the race on the `(listingId, idempotencyKey)` unique constraint: a concurrent
        // request with the same key committed first. Re-read the winning row (outside a new
        // transaction is fine here — it is now committed, terminal-for-this-purpose state) and
        // resolve it exactly like a pre-existing replay/conflict.
        const winner = await this.reservations.findByIdempotencyKey(
          input.listingId,
          input.idempotencyKey,
        );
        if (winner) {
          return assertReplayOrConflict(winner, input);
        }
      }
      throw err;
    }
  }
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002');
}

/**
 * Resolves an existing `(listingId, idempotencyKey)` row against the incoming request payload —
 * identical payload is a replay (return the original result, no new writes); a different
 * `orderId`/`quantity` is a conflict (deterministic `IDEMPOTENCY_CONFLICT`, never silently
 * returned).
 */
function assertReplayOrConflict(
  existing: { id: string; orderId: string | null; quantity: number; expiresAt: Date },
  input: ReserveStockInput,
): ReserveStockResult {
  const samePayload = existing.orderId === input.orderId && existing.quantity === input.quantity;
  if (!samePayload) {
    throw PharmacyInventoryErrors.idempotencyKeyConflict();
  }
  return { reservationId: existing.id, expiresAt: existing.expiresAt };
}
