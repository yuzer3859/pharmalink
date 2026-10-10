import { Injectable } from '@nestjs/common';
import request from 'supertest';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { OutboxCapableClient, OutboxService } from '../../src/shared/outbox/outbox.service';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/** Mirrors `test/profiles/atomicity.e2e-spec.ts`'s `PoisonedOutboxService` exactly (module-03
 * §9/§15 AC-7): a real `OutboxService` whose `write` can be armed to throw exactly once,
 * simulating a failure that occurs AFTER the domain state change (and audit insert) have already
 * executed as statements inside the caller's still-open transaction, but before commit. */
@Injectable()
class PoisonedOutboxService extends OutboxService {
  armed = false;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async write<T>(event: DomainEvent<T>, client?: OutboxCapableClient): Promise<void> {
    if (this.armed) {
      this.armed = false;
      throw new Error(
        'CONTROLLED_FAILURE: simulated outbox failure after the state mutation, before commit',
      );
    }
    return super.write(event, client);
  }
}

function medicineDto(overrides: Record<string, unknown> = {}) {
  return {
    type: 'MEDICINE',
    genericName: 'Paracetamol',
    dosageForm: 'TABLET',
    strengthValue: 500,
    strengthUnit: 'MG',
    rxClassification: 'OTC',
    nameEn: 'Paracetamol 500mg',
    ...overrides,
  };
}

/**
 * Proves that the domain state change, the audit entry, and the outbox event for every Catalog
 * mutation commit atomically in a single transaction — built in from day one (§9), unlike Module
 * 02 which retrofitted this after DEFECT-PROFILES-001/002. A controlled failure is injected into
 * the outbox write (the LAST statement in each command's transaction) so that, if the domain
 * mutation or the audit insert had already been committed independently, this test would observe
 * a partially-applied change; with everything in one transaction, Postgres rolls back all of it.
 */
describe('Catalog mutation atomicity — state + audit + outbox (e2e, AC-7)', () => {
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

  async function admin() {
    return createUserWithRole(ctx, 'ADMIN');
  }

  it('POST /admin/catalog/products: a failure after the insert rolls back the product row, ' +
    'the audit entry, and the outbox event together — no partial state survives', async () => {
    const a = await admin();
    const mfr = body(
      await request(ctx.server)
        .post('/admin/catalog/manufacturers')
        .set(...auth(a.accessToken))
        .send({ name: 'Acme Pharma' })
        .expect(201),
    );

    poisonedOutbox.armed = true;
    const failed = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfr.id }));
    expect(failed.status).toBe(500);
    expect(poisonedOutbox.armed).toBe(false);

    expect(await ctx.prisma.product.count({ where: { genericName: 'Paracetamol' } })).toBe(0);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'PRODUCT_CREATED', actorUserId: a.userId } }),
    ).toBe(0);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'catalog.product.created' } })).toBe(0);

    const retried = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfr.id }))
      .expect(201);

    expect(await ctx.prisma.product.count({ where: { genericName: 'Paracetamol' } })).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'PRODUCT_CREATED', actorUserId: a.userId } }),
    ).toBe(1);
    expect(
      await ctx.prisma.outbox.count({
        where: { eventType: 'catalog.product.created', aggregateId: body(retried).id as string },
      }),
    ).toBe(1);
  });

  it('PATCH /admin/catalog/products/:id: a failure after the update rolls back the edit, the ' +
    'audit entry, and the outbox event together', async () => {
    const a = await admin();
    const mfr = body(
      await request(ctx.server)
        .post('/admin/catalog/manufacturers')
        .set(...auth(a.accessToken))
        .send({ name: 'Acme Pharma' })
        .expect(201),
    );
    const created = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(a.accessToken))
        .send(medicineDto({ manufacturerId: mfr.id }))
        .expect(201),
    );

    poisonedOutbox.armed = true;
    const failed = await request(ctx.server)
      .patch(`/admin/catalog/products/${created.id}`)
      .set(...auth(a.accessToken))
      .send({ descriptionEn: 'Should not persist' });
    expect(failed.status).toBe(500);
    expect(poisonedOutbox.armed).toBe(false);

    const afterFailure = await ctx.prisma.product.findUniqueOrThrow({ where: { id: created.id as string } });
    expect(afterFailure.descriptionEn).toBeNull();
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'PRODUCT_UPDATED', resourceId: created.id as string } }),
    ).toBe(0);

    await request(ctx.server)
      .patch(`/admin/catalog/products/${created.id}`)
      .set(...auth(a.accessToken))
      .send({ descriptionEn: 'Should persist' })
      .expect(200);

    const afterSuccess = await ctx.prisma.product.findUniqueOrThrow({ where: { id: created.id as string } });
    expect(afterSuccess.descriptionEn).toBe('Should persist');
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'PRODUCT_UPDATED', resourceId: created.id as string } }),
    ).toBe(1);
  });

  it('POST /admin/catalog/products/:id/status: a failure after the transition rolls back the ' +
    'status change and the audit entry together', async () => {
    const a = await admin();
    const mfr = body(
      await request(ctx.server)
        .post('/admin/catalog/manufacturers')
        .set(...auth(a.accessToken))
        .send({ name: 'Acme Pharma' })
        .expect(201),
    );
    const created = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(a.accessToken))
        .send(medicineDto({ manufacturerId: mfr.id }))
        .expect(201),
    );

    // A draft is published only through review (module-16 Work 30) — two committed status changes —
    // so the transition under test is the next one this route performs: ACTIVE -> DEPRECATED.
    await request(ctx.server).post(`/admin/catalog/review/${created.id}/submit`).set(...auth(a.accessToken)).expect(200);
    await request(ctx.server).post(`/admin/catalog/review/${created.id}/approve`).set(...auth(a.accessToken)).expect(200);
    const committed = await ctx.prisma.auditLog.count({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceId: created.id as string } });
    expect(committed).toBe(2);

    poisonedOutbox.armed = true;
    const failed = await request(ctx.server)
      .post(`/admin/catalog/products/${created.id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'DEPRECATED' });
    expect(failed.status).toBe(500);

    const afterFailure = await ctx.prisma.product.findUniqueOrThrow({ where: { id: created.id as string } });
    expect(afterFailure.status).toBe('ACTIVE');
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceId: created.id as string } }),
    ).toBe(committed);

    await request(ctx.server)
      .post(`/admin/catalog/products/${created.id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'DEPRECATED' })
      .expect(200);

    const afterSuccess = await ctx.prisma.product.findUniqueOrThrow({ where: { id: created.id as string } });
    expect(afterSuccess.status).toBe('DEPRECATED');
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceId: created.id as string } }),
    ).toBe(committed + 1);
  });
});
