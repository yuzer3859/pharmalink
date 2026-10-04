import request from 'supertest';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { AdjustBatchCommand } from '../../src/modules/pharmacy-inventory/application/commands/adjust-batch.command';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

async function activeCatalogProduct(ctx: TestContext) {
  const admin = await createUserWithRole(ctx, 'ADMIN');
  const mfr = body(
    await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(admin.accessToken))
      .send({ name: 'Acme Pharma' })
      .expect(201),
  );
  const product = body(
    await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send({
        type: 'MEDICINE',
        genericName: 'Cetirizine',
        manufacturerId: mfr.id,
        dosageForm: 'TABLET',
        strengthValue: 10,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        nameEn: 'Cetirizine 10mg',
      })
      .expect(201),
  );
  await request(ctx.server)
    .post(`/admin/catalog/products/${product.id as string}/status`)
    .set(...auth(admin.accessToken))
    .send({ status: 'ACTIVE' })
    .expect(200);
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

/**
 * Module-04 hardening — global lock order for inventory mutations (backend/docs/
 * 04-pharmacy-inventory-spec.md §8/§12). `AdjustBatchCommand` used to lock batch-then-listing,
 * the exact inverse of `DispatchStockCommand`'s reservation→listing→batch order, which is a
 * classic Postgres AB-BA deadlock shape under real concurrent load. Both commands now agree on
 * listing-before-batch, proven here against a real Postgres instance (not mocks).
 */
describe('Adjustment vs. dispatch lock ordering (e2e, real Postgres concurrency)', () => {
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

  async function seedListingWithReservation(ctx: TestContext, quantity: number, reserveQty: number) {
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
    const listingId = listing.listingId as string;
    const movements = body(
      await request(ctx.server)
        .get(`/inventory/listings/${listingId}/movements`)
        .set(...auth(pharmacy.accessToken))
        .expect(200),
    );
    const batchId = (movements as { items: Array<{ batchId: string | null }> }).items.find(
      (m) => m.batchId,
    )?.batchId as string;

    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: reserveQty,
      orderId: 'order-lock-order-1',
      idempotencyKey: 'idem-lock-order-1',
    });
    await inventoryPort.confirm({ reservationId: reservation.reservationId });

    return { pharmacy, listingId, batchId, reservationId: reservation.reservationId };
  }

  it('a concurrent AdjustBatchCommand and DispatchStockCommand on the same listing/batch do not ' +
    'deadlock and both complete with a correct, reconciled final state', async () => {
    const { pharmacy, listingId, batchId, reservationId } = await seedListingWithReservation(ctx, 20, 5);
    const adjustBatch = ctx.app.get(AdjustBatchCommand);

    const results = await Promise.allSettled([
      adjustBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        batchId,
        quantityDelta: 10,
        reason: 'Restock recount',
      }),
      inventoryPort.dispatch({ reservationId }),
    ]);

    // Neither should fail with a Postgres deadlock error (or any error at all) — the whole
    // point of fixing the lock order is that both operations simply complete.
    for (const result of results) {
      if (result.status === 'rejected') {
        throw new Error(`Unexpected rejection (possible deadlock): ${String(result.reason)}`);
      }
    }

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    // Started at 20 onHand; adjustment +10; dispatch -5 (the reserved/confirmed quantity).
    expect(listingRow.onHand).toBe(25);
    expect(listingRow.reserved).toBe(0);
    await reconcile(ctx, listingId);
  });

  it('two concurrent adjustments to the same batch do not lose an update', async () => {
    const { pharmacy, listingId, batchId } = await seedListingWithReservation(ctx, 20, 0);
    const adjustBatch = ctx.app.get(AdjustBatchCommand);

    const results = await Promise.allSettled([
      adjustBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        batchId,
        quantityDelta: 5,
        reason: 'Recount A',
      }),
      adjustBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        batchId,
        quantityDelta: 7,
        reason: 'Recount B',
      }),
    ]);
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
    }

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.onHand).toBe(32); // 20 + 5 + 7, neither update lost
    await reconcile(ctx, listingId);
  });

  it('lock acquisition order for AdjustBatchCommand is listing-then-batch (asserted via a spy ' +
    'on both repositories inside the real DI-wired app)', async () => {
    const { pharmacy, listingId, batchId } = await seedListingWithReservation(ctx, 10, 0);
    const adjustBatch = ctx.app.get(AdjustBatchCommand);

    const order: string[] = [];
    const listingRepo = (adjustBatch as unknown as { listings: { lockForUpdate: (...args: unknown[]) => unknown } })[
      'listings'
    ];
    const ledgerRepo = (adjustBatch as unknown as { ledger: { lockBatchForUpdate: (...args: unknown[]) => unknown } })[
      'ledger'
    ];
    const originalListingLock = listingRepo.lockForUpdate.bind(listingRepo);
    const originalBatchLock = ledgerRepo.lockBatchForUpdate.bind(ledgerRepo);
    listingRepo.lockForUpdate = async (...args: unknown[]) => {
      order.push('listing');
      return originalListingLock(...args);
    };
    ledgerRepo.lockBatchForUpdate = async (...args: unknown[]) => {
      order.push('batch');
      return originalBatchLock(...args);
    };

    try {
      await adjustBatch.execute({
        actorUserId: pharmacy.userId,
        pharmacyId: pharmacy.pharmacyId,
        batchId,
        quantityDelta: 1,
        reason: 'Order check',
      });
      expect(order).toEqual(['listing', 'batch']);
    } finally {
      listingRepo.lockForUpdate = originalListingLock;
      ledgerRepo.lockBatchForUpdate = originalBatchLock;
    }
    void listingId;
  });
});
