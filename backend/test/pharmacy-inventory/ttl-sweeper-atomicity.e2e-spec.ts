import { Injectable } from '@nestjs/common';
import request from 'supertest';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { OutboxCapableClient, OutboxService } from '../../src/shared/outbox/outbox.service';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { ReservationTtlSweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/reservation-ttl.sweeper';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

/** Mirrors `atomicity.e2e-spec.ts`'s `PoisonedOutboxService` exactly (module-04 §12). */
@Injectable()
class PoisonedOutboxService extends OutboxService {
  armed = false;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async write<T>(event: DomainEvent<T>, client?: OutboxCapableClient): Promise<void> {
    if (this.armed) {
      this.armed = false;
      throw new Error('CONTROLLED_FAILURE: simulated outbox failure inside the TTL sweeper transaction');
    }
    return super.write(event, client);
  }
}

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
        genericName: 'Amoxicillin',
        manufacturerId: mfr.id,
        dosageForm: 'CAPSULE',
        strengthValue: 500,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        nameEn: 'Amoxicillin 500mg',
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

async function seedListing(ctx: TestContext, quantity = 10) {
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
        price: 900,
        batchNumber: 'B-1',
        initialQuantity: quantity,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .expect(201),
  );
  return { listingId: listing.listingId as string };
}

/**
 * Module-04 hardening — TTL expiration atomicity (backend/docs/04-pharmacy-inventory-spec.md §8).
 * Proves the fixed `ReservationTtlSweeper` never commits a partially-applied expiration: the
 * reservation's terminal status, its RELEASE movement, the listing's cache update, and the
 * outbox event either all land together, or none of them do.
 */
describe('ReservationTtlSweeper atomicity (e2e, real Postgres)', () => {
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

  it('a valid TTL expiration atomically changes reservation status, writes a RELEASE movement, ' +
    'updates the listing cache, and writes the outbox event', async () => {
    const { listingId } = await seedListing(ctx, 10);
    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: 4,
      orderId: 'order-ttl-valid',
      idempotencyKey: 'idem-ttl-valid',
    });
    await ctx.prisma.stockReservation.update({
      where: { id: reservation.reservationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const sweeper = ctx.app.get(ReservationTtlSweeper);
    const processed = await sweeper.run();
    expect(processed).toBe(1);

    const reservationRow = await ctx.prisma.stockReservation.findUniqueOrThrow({
      where: { id: reservation.reservationId },
    });
    expect(reservationRow.status).toBe('EXPIRED');

    const releaseMovement = await ctx.prisma.stockMovement.findFirst({
      where: { listingId, type: 'RELEASE', reservationId: reservation.reservationId },
    });
    expect(releaseMovement).not.toBeNull();
    expect(releaseMovement?.quantityDelta).toBe(4);

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.reserved).toBe(0);
    expect(listingRow.sellable).toBe(10);

    const outboxRow = await ctx.prisma.outbox.findFirst({
      where: { eventType: 'pharmacy.stock.released', aggregateId: listingId },
    });
    expect(outboxRow).not.toBeNull();
  });

  it('an invariant failure (listing.reserved corrupted below the reservation quantity) leaves ' +
    'reservation status, movements, listing cache, and outbox completely unchanged — no partial ' +
    'expiration is ever committed', async () => {
    const { listingId } = await seedListing(ctx, 10);
    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: 4,
      orderId: 'order-ttl-invariant',
      idempotencyKey: 'idem-ttl-invariant',
    });
    await ctx.prisma.stockReservation.update({
      where: { id: reservation.reservationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    // Directly corrupt the cache to simulate a pre-existing invariant violation: reserved (0) is
    // now less than this HELD reservation's own quantity (4).
    await ctx.prisma.inventoryListing.update({ where: { id: listingId }, data: { reserved: 0 } });

    const movementsBefore = await ctx.prisma.stockMovement.count({ where: { listingId } });
    const outboxBefore = await ctx.prisma.outbox.count();

    const sweeper = ctx.app.get(ReservationTtlSweeper);
    const processed = await sweeper.run();
    expect(processed).toBe(0);

    const reservationRow = await ctx.prisma.stockReservation.findUniqueOrThrow({
      where: { id: reservation.reservationId },
    });
    expect(reservationRow.status).toBe('HELD');

    expect(await ctx.prisma.stockMovement.count({ where: { listingId } })).toBe(movementsBefore);
    expect(await ctx.prisma.outbox.count()).toBe(outboxBefore);

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.reserved).toBe(0); // untouched by the sweeper, still the corrupted value
  });

  it('a forced outbox failure inside the TTL sweeper transaction rolls back the status, ' +
    'movement, and cache changes together — retrying afterwards then commits everything', async () => {
    const poisoned = await createTestApp([{ provide: OutboxService, useClass: PoisonedOutboxService }]);
    const poisonedOutbox = poisoned.app.get(OutboxService) as unknown as PoisonedOutboxService;
    try {
      const poisonedPort = poisoned.app.get<IInventoryPort>(INVENTORY_PORT);
      const { listingId } = await seedListing(poisoned, 10);
      const reservation = await poisonedPort.reserve({
        listingId,
        quantity: 3,
        orderId: 'order-ttl-outbox-fail',
        idempotencyKey: 'idem-ttl-outbox-fail',
      });
      await poisoned.prisma.stockReservation.update({
        where: { id: reservation.reservationId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const sweeper = poisoned.app.get(ReservationTtlSweeper);
      poisonedOutbox.armed = true;
      const processed = await sweeper.run();
      expect(processed).toBe(0);
      expect(poisonedOutbox.armed).toBe(false);

      const reservationRow = await poisoned.prisma.stockReservation.findUniqueOrThrow({
        where: { id: reservation.reservationId },
      });
      expect(reservationRow.status).toBe('HELD');
      expect(
        await poisoned.prisma.stockMovement.count({ where: { listingId, type: 'RELEASE' } }),
      ).toBe(0);
      const listingRow = await poisoned.prisma.inventoryListing.findUniqueOrThrow({
        where: { id: listingId },
      });
      expect(listingRow.reserved).toBe(3);
      expect(listingRow.sellable).toBe(7);

      // Retried, unpoisoned: now commits everything together.
      const retried = await sweeper.run();
      expect(retried).toBe(1);
      const afterRetry = await poisoned.prisma.stockReservation.findUniqueOrThrow({
        where: { id: reservation.reservationId },
      });
      expect(afterRetry.status).toBe('EXPIRED');
      const listingAfterRetry = await poisoned.prisma.inventoryListing.findUniqueOrThrow({
        where: { id: listingId },
      });
      expect(listingAfterRetry.reserved).toBe(0);
      expect(listingAfterRetry.sellable).toBe(10);
    } finally {
      await closeTestApp(poisoned);
    }
  });
});
