import { Injectable } from '@nestjs/common';
import request from 'supertest';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { OutboxCapableClient, OutboxService } from '../../src/shared/outbox/outbox.service';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { AddBatchCommand } from '../../src/modules/pharmacy-inventory/application/commands/add-batch.command';
import { AdjustBatchCommand } from '../../src/modules/pharmacy-inventory/application/commands/adjust-batch.command';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

/** Mirrors `ttl-sweeper-atomicity.e2e-spec.ts`'s `PoisonedOutboxService` exactly (module-04 §12). */
@Injectable()
class PoisonedOutboxService extends OutboxService {
  armed = false;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async write<T>(event: DomainEvent<T>, client?: OutboxCapableClient): Promise<void> {
    if (this.armed) {
      this.armed = false;
      throw new Error('CONTROLLED_FAILURE: simulated outbox failure inside AddBatchCommand');
    }
    return super.write(event, client);
  }
}

async function activeCatalogProduct(ctx: TestContext, nameEn = 'Cetirizine 10mg') {
  const admin = await createUserWithRole(ctx, 'ADMIN');
  const mfr = body(
    await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(admin.accessToken))
      .send({ name: `Acme Pharma (${nameEn})` })
      .expect(201),
  );
  const product = body(
    await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send({
        type: 'MEDICINE',
        genericName: nameEn,
        manufacturerId: mfr.id,
        dosageForm: 'TABLET',
        strengthValue: 10,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        nameEn,
      })
      .expect(201),
  );
  // Published only through catalogue review (module-16 Work 30): submit (DRAFT -> PENDING_REVIEW), then approve (-> ACTIVE).
  await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(admin.accessToken)).expect(200);
  await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(admin.accessToken)).expect(200);
  return product.id as string;
}

async function reconcile(ctx: TestContext, listingId: string) {
  const listing = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
  const sum = await ctx.prisma.stockMovement.aggregate({
    where: { listingId, type: { in: ['RECEIPT', 'ADJUST', 'DISPATCH'] } },
    _sum: { quantityDelta: true },
  });
  expect(sum._sum.quantityDelta ?? 0).toBe(listing.onHand);
}

async function seedListing(
  ctx: TestContext,
  quantity: number,
): Promise<{ pharmacy: Awaited<ReturnType<typeof createActivatedPharmacy>>; listingId: string }> {
  const pharmacy = await createActivatedPharmacy(ctx);
  const productId = await activeCatalogProduct(ctx);
  const branch = body(
    await request(ctx.server)
      .post('/pharmacy/branches')
      .set(...auth(pharmacy.accessToken))
      .send({ name: 'Main Branch' })
      .expect(201),
  );
  const listing = body(
    await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(pharmacy.accessToken))
      .send({
        catalogProductId: productId,
        branchId: branch.branchId,
        price: 400,
        batchNumber: 'B-1',
        initialQuantity: quantity,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .expect(201),
  );
  return { pharmacy, listingId: listing.listingId as string };
}

/**
 * Module-04 hardening — `AddBatchCommand` stale-read/lost-update fix (backend/docs/
 * 04-pharmacy-inventory-spec.md §3.6/§3.10, §8, §12). `AddBatchCommand` used to read the listing
 * BEFORE opening its transaction and then compute the new `onHand`/`sellable` cache from that
 * stale, pre-transaction snapshot. Two concurrent batch additions (or a batch addition racing
 * reserve/dispatch/adjustment) could overwrite each other's cache update, leaving
 * `inventory_listings.onHand`/`.reserved`/`.sellable` inconsistent with the live batches,
 * reservations, and stock ledger. `AddBatchCommand` now locks the listing (`FOR UPDATE`) and
 * re-reads it INSIDE the transaction before computing anything, exactly like `AdjustBatchCommand`.
 */
describe('AddBatchCommand concurrency hardening (e2e, real Postgres)', () => {
  let ctx: TestContext;
  let inventoryPort: IInventoryPort;

  beforeAll(async () => {
    ctx = await createTestApp();
    inventoryPort = ctx.app.get<IInventoryPort>(INVENTORY_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  it('two concurrent AddBatchCommand requests against the same listing both succeed and no ' +
    'cache update is lost', async () => {
    const { pharmacy, listingId } = await seedListing(ctx, 10);
    const addBatch = ctx.app.get(AddBatchCommand);
    const expiryDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const results = await Promise.allSettled([
      addBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        listingId,
        batchNumber: 'B-2',
        quantity: 15,
        expiryDate,
      }),
      addBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        listingId,
        batchNumber: 'B-3',
        quantity: 25,
        expiryDate,
      }),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        throw new Error(`Unexpected rejection: ${String(result.reason)}`);
      }
    }

    const batches = await ctx.prisma.stockBatch.findMany({ where: { listingId } });
    expect(batches).toHaveLength(3); // initial B-1 + B-2 + B-3

    const receiptCount = await ctx.prisma.stockMovement.count({
      where: { listingId, type: 'RECEIPT' },
    });
    expect(receiptCount).toBe(3);

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    // Started at 10 onHand (initial batch); +15 +25 from the two concurrent adds. Neither
    // update may be lost.
    expect(listingRow.onHand).toBe(50);
    expect(listingRow.sellable).toBe(50);
    await reconcile(ctx, listingId);
  });

  it('AddBatchCommand racing IInventoryPort.reserve() does not deadlock, loses no update, and ' +
    'produces exactly one StockReceived and one StockReserved event', async () => {
    const { pharmacy, listingId } = await seedListing(ctx, 20);
    const addBatch = ctx.app.get(AddBatchCommand);

    // Baseline: `seedListing` itself creates the listing with an initial batch, which already
    // emits one `pharmacy.stock.received` event for this listing (module-04 `CreateListingCommand`).
    // The assertions below must count events produced by THIS test's two racing commands, not
    // the listing-creation event that happened before them.
    const receivedBefore = await ctx.prisma.outbox.count({
      where: { eventType: 'pharmacy.stock.received', aggregateId: listingId },
    });
    const reservedBefore = await ctx.prisma.outbox.count({
      where: { eventType: 'pharmacy.stock.reserved', aggregateId: listingId },
    });

    const results = await Promise.allSettled([
      addBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        listingId,
        batchNumber: 'B-2',
        quantity: 10,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      inventoryPort.reserve({
        listingId,
        quantity: 5,
        orderId: 'order-add-reserve-race',
        idempotencyKey: 'idem-add-reserve-race',
      }),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        throw new Error(`Unexpected rejection (possible deadlock): ${String(result.reason)}`);
      }
    }

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.onHand).toBe(30); // 20 initial + 10 received
    expect(listingRow.reserved).toBe(5);
    expect(listingRow.sellable).toBe(25); // 30 onHand - 5 reserved
    await reconcile(ctx, listingId);

    await ctx.drainOutbox();
    const receivedEvents = await ctx.prisma.outbox.count({
      where: { eventType: 'pharmacy.stock.received', aggregateId: listingId },
    });
    const reservedEvents = await ctx.prisma.outbox.count({
      where: { eventType: 'pharmacy.stock.reserved', aggregateId: listingId },
    });
    expect(receivedEvents - receivedBefore).toBe(1);
    expect(reservedEvents - reservedBefore).toBe(1);
  });

  it('AddBatchCommand racing DispatchStockCommand does not deadlock, loses no update, and ' +
    'leaves batches/cache/movements reconcilable', async () => {
    const { pharmacy, listingId } = await seedListing(ctx, 20);
    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: 5,
      orderId: 'order-add-dispatch-race',
      idempotencyKey: 'idem-add-dispatch-race',
    });
    await inventoryPort.confirm({ reservationId: reservation.reservationId });

    const addBatch = ctx.app.get(AddBatchCommand);
    const results = await Promise.allSettled([
      addBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        listingId,
        batchNumber: 'B-2',
        quantity: 12,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      inventoryPort.dispatch({ reservationId: reservation.reservationId }),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        throw new Error(`Unexpected rejection (possible deadlock): ${String(result.reason)}`);
      }
    }

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    // 20 initial + 12 received - 5 dispatched = 27 onHand; reserved returns to 0.
    expect(listingRow.onHand).toBe(27);
    expect(listingRow.reserved).toBe(0);
    await reconcile(ctx, listingId);
  });

  it('AddBatchCommand racing AdjustBatchCommand (a different batch on the same listing) does ' +
    'not deadlock, loses no update, and leaves batches/cache/movements reconcilable', async () => {
    const { pharmacy, listingId } = await seedListing(ctx, 20);
    const movements = body(
      await request(ctx.server)
        .get(`/inventory/listings/${listingId}/movements`)
        .set(...auth(pharmacy.accessToken))
        .expect(200),
    );
    const existingBatchId = (movements as { items: Array<{ batchId: string | null }> }).items.find(
      (m) => m.batchId,
    )?.batchId as string;

    const addBatch = ctx.app.get(AddBatchCommand);
    const adjustBatch = ctx.app.get(AdjustBatchCommand);

    const results = await Promise.allSettled([
      addBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        listingId,
        batchNumber: 'B-2',
        quantity: 8,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      adjustBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        batchId: existingBatchId,
        quantityDelta: 6,
        reason: 'Recount',
      }),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        throw new Error(`Unexpected rejection (possible deadlock): ${String(result.reason)}`);
      }
    }

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.onHand).toBe(34); // 20 + 8 (receipt) + 6 (adjust)
    await reconcile(ctx, listingId);
  });

  it('a forced outbox failure inside AddBatchCommand rolls back the batch, movement, and cache ' +
    'changes together — no orphaned batch, movement, or cache mutation remains', async () => {
    const poisoned = await createTestApp([{ provide: OutboxService, useClass: PoisonedOutboxService }]);
    const poisonedOutbox = poisoned.app.get(OutboxService) as unknown as PoisonedOutboxService;
    try {
      const { pharmacy, listingId } = await seedListing(poisoned, 10);
      const addBatch = poisoned.app.get(AddBatchCommand);

      const batchesBefore = await poisoned.prisma.stockBatch.count({ where: { listingId } });
      const movementsBefore = await poisoned.prisma.stockMovement.count({ where: { listingId } });
      const listingBefore = await poisoned.prisma.inventoryListing.findUniqueOrThrow({
        where: { id: listingId },
      });
      const auditBefore = await poisoned.prisma.auditLog.count({
        where: { resourceType: 'InventoryListing', resourceId: listingId },
      });
      const outboxBefore = await poisoned.prisma.outbox.count();

      poisonedOutbox.armed = true;
      await expect(
        addBatch.execute({
          actorUserId: pharmacy.userId,
          pharmacyId: pharmacy.pharmacyId,
          listingId,
          batchNumber: 'B-FAIL',
          quantity: 99,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ).rejects.toThrow('CONTROLLED_FAILURE');
      expect(poisonedOutbox.armed).toBe(false);

      expect(await poisoned.prisma.stockBatch.count({ where: { listingId } })).toBe(batchesBefore);
      expect(await poisoned.prisma.stockMovement.count({ where: { listingId } })).toBe(movementsBefore);
      const listingAfter = await poisoned.prisma.inventoryListing.findUniqueOrThrow({
        where: { id: listingId },
      });
      expect(listingAfter.onHand).toBe(listingBefore.onHand);
      expect(listingAfter.sellable).toBe(listingBefore.sellable);
      expect(
        await poisoned.prisma.auditLog.count({
          where: { resourceType: 'InventoryListing', resourceId: listingId },
        }),
      ).toBe(auditBefore);
      expect(await poisoned.prisma.outbox.count()).toBe(outboxBefore);

      // Retried, unpoisoned: now commits everything together.
      const retried = await addBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        listingId,
        batchNumber: 'B-RETRY',
        quantity: 7,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(retried.batchId).toBeTruthy();
      const listingAfterRetry = await poisoned.prisma.inventoryListing.findUniqueOrThrow({
        where: { id: listingId },
      });
      expect(listingAfterRetry.onHand).toBe(listingBefore.onHand + 7);
    } finally {
      await closeTestApp(poisoned);
    }
  });

  it('receiving a future-valid batch increases onHand and sellable; an expired-date batch is ' +
    'rejected before any write', async () => {
    const { pharmacy, listingId } = await seedListing(ctx, 10);
    const addBatch = ctx.app.get(AddBatchCommand);

    await expect(
      addBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        listingId,
        batchNumber: 'B-EXPIRED',
        quantity: 5,
        expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      }),
    ).rejects.toThrow();

    const listingAfterRejected = await ctx.prisma.inventoryListing.findUniqueOrThrow({
      where: { id: listingId },
    });
    expect(listingAfterRejected.onHand).toBe(10);
    expect(listingAfterRejected.sellable).toBe(10);
    expect(await ctx.prisma.stockBatch.count({ where: { listingId, batchNumber: 'B-EXPIRED' } })).toBe(0);

    const result = await addBatch.execute({
      actorUserId: pharmacy.userId,
      pharmacyId: pharmacy.pharmacyId,
      listingId,
      batchNumber: 'B-FUTURE',
      quantity: 15,
      expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(result.batchId).toBeTruthy();

    const listingAfterValid = await ctx.prisma.inventoryListing.findUniqueOrThrow({
      where: { id: listingId },
    });
    expect(listingAfterValid.onHand).toBe(25);
    expect(listingAfterValid.sellable).toBe(25);
    await reconcile(ctx, listingId);
  });
});
