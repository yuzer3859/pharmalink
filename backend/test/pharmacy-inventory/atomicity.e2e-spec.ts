import { Injectable } from '@nestjs/common';
import request from 'supertest';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { OutboxCapableClient, OutboxService } from '../../src/shared/outbox/outbox.service';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

/** Mirrors `test/catalog/atomicity.e2e-spec.ts`'s `PoisonedOutboxService` exactly (module-04 §12). */
@Injectable()
class PoisonedOutboxService extends OutboxService {
  armed = false;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async write<T>(event: DomainEvent<T>, client?: OutboxCapableClient): Promise<void> {
    if (this.armed) {
      this.armed = false;
      throw new Error('CONTROLLED_FAILURE: simulated outbox failure after the state mutation, before commit');
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
        genericName: 'Ibuprofen',
        manufacturerId: mfr.id,
        dosageForm: 'TABLET',
        strengthValue: 200,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        nameEn: 'Ibuprofen 200mg',
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

describe('Pharmacy & Inventory mutation atomicity — state + audit + outbox (e2e)', () => {
  let ctx: TestContext;
  let poisonedOutbox: PoisonedOutboxService;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: OutboxService, useClass: PoisonedOutboxService }]);
    poisonedOutbox = ctx.app.get(OutboxService) as unknown as PoisonedOutboxService;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    poisonedOutbox.armed = false;
  });

  it('POST /inventory/listings: a failure after the insert rolls back the listing, batch, movement, audit entry, and outbox event together', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );
    const dto = {
      catalogProductId: productId,
      branchId: branch.branchId,
      price: 1200,
      batchNumber: 'B-1',
      initialQuantity: 10,
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    };

    poisonedOutbox.armed = true;
    const failed = await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(pharmacy.accessToken))
      .send(dto);
    expect(failed.status).toBe(500);
    expect(poisonedOutbox.armed).toBe(false);

    expect(
      await ctx.prisma.inventoryListing.count({ where: { branchId: branch.branchId as string } }),
    ).toBe(0);
    expect(await ctx.prisma.stockBatch.count()).toBe(0);
    expect(await ctx.prisma.stockMovement.count()).toBe(0);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'LISTING_CREATED' } }),
    ).toBe(0);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'pharmacy.listing.created' } })).toBe(0);

    const retried = await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(pharmacy.accessToken))
      .send(dto)
      .expect(201);

    expect(
      await ctx.prisma.inventoryListing.count({ where: { branchId: branch.branchId as string } }),
    ).toBe(1);
    expect(
      await ctx.prisma.outbox.count({
        where: { eventType: 'pharmacy.listing.created', aggregateId: body(retried).listingId as string },
      }),
    ).toBe(1);
  });
});
