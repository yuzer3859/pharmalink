import { Injectable } from '@nestjs/common';
import request from 'supertest';
import { AuditChainEntry, verifyChain } from '../../src/shared/audit/audit-hash';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { OutboxCapableClient, OutboxService } from '../../src/shared/outbox/outbox.service';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { ReleaseReservationCommand } from '../../src/modules/pharmacy-inventory/application/commands/release-reservation.command';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { auth, body, createUserWithRole, login, registerAndVerify, STRONG_PASSWORD } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

/**
 * Mirrors `test/catalog/atomicity.e2e-spec.ts` / `test/pharmacy-inventory/atomicity.e2e-spec.ts`'s
 * `PoisonedOutboxService` exactly: a real `OutboxService` whose `write` can be armed to throw
 * once, simulating a failure inside the caller's still-open transaction, after the audit insert
 * has already run as a statement but before commit.
 */
@Injectable()
class PoisonedOutboxService extends OutboxService {
  armed = false;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async write<T>(event: DomainEvent<T>, client?: OutboxCapableClient): Promise<void> {
    if (this.armed) {
      this.armed = false;
      throw new Error('CONTROLLED_FAILURE: simulated outbox failure after the audit insert, before commit');
    }
    return super.write(event, client);
  }
}

/**
 * Module-04 §17.5 — audit-chain integrity extension of the shared hash-chain guarantee proven in
 * `src/shared/audit/audit-hash.spec.ts` (pure `computeEntryHash`/`verifyChain` unit tests) and
 * exercised end-to-end for a single module in `test/profiles/profile.e2e-spec.ts`'s "AC-6 /
 * audit" test. Neither of those crosses a module boundary; this spec proves `AuditService`'s
 * single global `audit_logs` table (see `AuditService.append`'s `findFirst orderBy createdAt
 * desc`, with NO module/tenant scoping) really does chain Module 04 entries onto whatever
 * Module 01/02/03 wrote immediately before them, and that a mid-transaction failure still can't
 * leave an orphaned Module 04 audit row (the `AuditService.record(params, tx)` signature already
 * used by every other module's mutation commands).
 */
describe('Cross-module audit hash-chain integrity — Module 04 boundary (module-04 §17.5, e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  async function activeCatalogProduct() {
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

  it('a Module 01 action, a Module 02 action, a Module 03 action, and Module 04 actions ' +
    'chain unbroken into the SAME global audit_logs sequence, in commit order', async () => {
    // Module 01 — Identity: password change writes `identity.password.changed`.
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);
    await request(ctx.server)
      .post('/auth/password/change')
      .set(...auth(tokens.accessToken))
      .send({ oldPassword: STRONG_PASSWORD, newPassword: 'Ev3nStr0ngerPassw0rd' })
      .expect(201);

    // Module 02 — Profiles: PATCH /profile/me writes `PROFILE_UPDATED`.
    const freshTokens = await login(ctx, user.phone, 'Ev3nStr0ngerPassw0rd');
    await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(freshTokens.accessToken))
      .send({ fullName: 'Abebe Kebede' })
      .expect(200);

    // Module 03 — Catalog: creating a product writes `PRODUCT_CREATED`.
    const productId = await activeCatalogProduct();

    // Module 04 — Pharmacy & Inventory: registration + activation write `PHARMACY_ACTIVATED`;
    // creating a listing writes `LISTING_CREATED`.
    const pharmacy = await createActivatedPharmacy(ctx);
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
          price: 100,
          batchNumber: 'B-1',
          initialQuantity: 10,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );

    // The whole `audit_logs` table, in commit order, must contain all of the above and chain
    // unbroken end to end — module boundaries are invisible to the chain.
    const rows = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'identity.password.changed',
        'PROFILE_UPDATED',
        'PRODUCT_CREATED',
        'PHARMACY_ACTIVATED',
        'LISTING_CREATED',
      ]),
    );

    const entries: AuditChainEntry[] = rows.map((r) => ({
      actorUserId: r.actorUserId,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      context: r.context,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
      prevHash: r.prevHash,
      hash: r.hash,
    }));
    expect(verifyChain(entries)).toBe(-1);

    // Spot-check the module boundary directly: the Module 04 `PHARMACY_ACTIVATED` entry's
    // `prevHash` must equal the hash of whatever entry immediately preceded it — regardless of
    // which module wrote that entry.
    const pharmacyActivatedIdx = rows.findIndex((r) => r.action === 'PHARMACY_ACTIVATED');
    expect(pharmacyActivatedIdx).toBeGreaterThan(0);
    expect(rows[pharmacyActivatedIdx].prevHash).toBe(rows[pharmacyActivatedIdx - 1].hash);

    const listingCreatedIdx = rows.findIndex((r) => r.action === 'LISTING_CREATED');
    expect(listingCreatedIdx).toBeGreaterThan(0);
    expect(rows[listingCreatedIdx].prevHash).toBe(rows[listingCreatedIdx - 1].hash);
    expect((listing as { listingId: string }).listingId).toEqual(expect.any(String));
  });

  it('RESERVATION_RELEASED (manual release) and BATCH_ADJUSTED audit rows also chain correctly ' +
    'onto the preceding global entry', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct();
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );
    const created = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productId,
          branchId: branch.branchId,
          price: 100,
          batchNumber: 'B-1',
          initialQuantity: 10,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    // Manual reservation release (module-04 §8/§12) has no HTTP surface in Slice 1 (only the
    // `IInventoryPort.release` path, which never sets `manual:true`) — invoke the command
    // directly, exactly as an eventual admin/ops manual-release endpoint would, to exercise the
    // `RESERVATION_RELEASED` audit action.
    const inventoryPort = ctx.app.get(INVENTORY_PORT) as IInventoryPort;
    const reserved = await inventoryPort.reserve({
      listingId: created.listingId as string,
      quantity: 2,
      orderId: 'order-manual-release',
      idempotencyKey: 'idem-manual-release',
    });
    const releaseReservation = ctx.app.get(ReleaseReservationCommand);
    await releaseReservation.execute({
      reservationId: reserved.reservationId,
      reason: 'Ops manual release',
      actorUserId: pharmacy.userId,
      manual: true,
    });

    const batches = body(
      await request(ctx.server)
        .get(`/inventory/listings/${created.listingId as string}/movements`)
        .set(...auth(pharmacy.accessToken))
        .expect(200),
    );
    const batchId = (batches as { items: Array<{ batchId: string | null }> }).items.find(
      (m) => m.batchId,
    )?.batchId as string;
    expect(batchId).toEqual(expect.any(String));

    await request(ctx.server)
      .patch(`/inventory/batches/${batchId}`)
      .set(...auth(pharmacy.accessToken))
      .send({ quantityDelta: -2, reason: 'Damaged in storage' })
      .expect(200);

    const rows = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    const entries: AuditChainEntry[] = rows.map((r) => ({
      actorUserId: r.actorUserId,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      context: r.context,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
      prevHash: r.prevHash,
      hash: r.hash,
    }));
    expect(verifyChain(entries)).toBe(-1);

    const reservationReleasedIdx = rows.findIndex((r) => r.action === 'RESERVATION_RELEASED');
    expect(reservationReleasedIdx).toBeGreaterThan(0);
    expect(rows[reservationReleasedIdx].prevHash).toBe(rows[reservationReleasedIdx - 1].hash);

    const batchAdjustedIdx = rows.findIndex((r) => r.action === 'BATCH_ADJUSTED');
    expect(batchAdjustedIdx).toBeGreaterThan(0);
    expect(rows[batchAdjustedIdx].prevHash).toBe(rows[batchAdjustedIdx - 1].hash);
  });

  it('a mid-transaction outbox failure leaves NO orphaned Module 04 audit row — the audit ' +
    'insert rolls back with everything else in the same transaction', async () => {
    const poisoned = await createTestApp([{ provide: OutboxService, useClass: PoisonedOutboxService }]);
    const poisonedOutbox = poisoned.app.get(OutboxService) as unknown as PoisonedOutboxService;
    try {
      const pharmacy = await createActivatedPharmacy(poisoned);
      const productId = await (async () => {
        const admin = await createUserWithRole(poisoned, 'ADMIN');
        const mfr = body(
          await request(poisoned.server)
            .post('/admin/catalog/manufacturers')
            .set(...auth(admin.accessToken))
            .send({ name: 'Acme Pharma' })
            .expect(201),
        );
        const product = body(
          await request(poisoned.server)
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
        await request(poisoned.server)
          .post(`/admin/catalog/products/${product.id as string}/status`)
          .set(...auth(admin.accessToken))
          .send({ status: 'ACTIVE' })
          .expect(200);
        return product.id as string;
      })();
      const branch = body(
        await request(poisoned.server)
          .post('/pharmacy/branches')
          .set(...auth(pharmacy.accessToken))
          .send({ name: 'Main Branch' })
          .expect(201),
      );

      const beforeCount = await poisoned.prisma.auditLog.count();

      poisonedOutbox.armed = true;
      const failed = await request(poisoned.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productId,
          branchId: branch.branchId,
          price: 100,
          batchNumber: 'B-1',
          initialQuantity: 10,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        });
      expect(failed.status).toBe(500);
      expect(poisonedOutbox.armed).toBe(false);

      expect(await poisoned.prisma.auditLog.count()).toBe(beforeCount);
      expect(
        await poisoned.prisma.auditLog.count({ where: { action: 'LISTING_CREATED' } }),
      ).toBe(0);

      // Same request, unpoisoned, now commits the audit row, the outbox row, and the state
      // change together — proving the earlier failure was a one-shot injection, not breakage.
      const retried = await request(poisoned.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productId,
          branchId: branch.branchId,
          price: 100,
          batchNumber: 'B-1',
          initialQuantity: 10,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201);
      expect(
        await poisoned.prisma.auditLog.count({
          where: { action: 'LISTING_CREATED', resourceId: body(retried).listingId as string },
        }),
      ).toBe(1);
    } finally {
      await closeTestApp(poisoned);
    }
  });
});
