import request from 'supertest';
import { LicenseExpirySweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/license-expiry.sweeper';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

/**
 * Event-contract tests (module-04 §17.4 / §9 "Contract-testing note"): for every domain event
 * this module emits, trigger the real command through the app, read back the resulting `outbox`
 * row, and assert its envelope + payload conform to:
 *   - `backend/docs/04-pharmacy-inventory-spec.md` §9 (the payload/trigger table — authoritative
 *     per that doc's "APPROVED" status; used as the tie-breaker if it and the catalog disagree),
 *   - `architecture/00-domain-event-catalog.md`'s Module 04 row (event names + consumer-facing
 *     payload fields),
 *   - the actual `DomainEvent` envelope shape written by `OutboxService.write` (see
 *     `src/shared/events/domain-event.ts` / `src/shared/outbox/outbox.service.ts`): the stored
 *     `outbox.payload` column is the FULL envelope `{ id, type, aggregateType, aggregateId,
 *     payload, occurredAt }`, not just the inner payload — same convention Module 03's
 *     `domain/events.ts` uses (dotted lower-case `type`, e.g. `pharmacy.pharmacy.activated`,
 *     mirroring `catalog.product.created`). There is no prior *automated* contract test for this
 *     in Modules 02/03 (none found under `src`/`test` referencing
 *     `00-domain-event-catalog.md` at review time) — this spec establishes the pattern for the
 *     codebase, reusing this module's own e2e `support.ts` + the `PoisonedOutboxService`-adjacent
 *     "read straight from `ctx.prisma.outbox`" idiom already used in
 *     `test/pharmacy-inventory/atomicity.e2e-spec.ts`.
 */
describe('Pharmacy & Inventory domain events — contract vs. 00-domain-event-catalog.md / module-04 §9 (e2e)', () => {
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

  /** Reads back the single outbox row for `eventType`, parsed as the full `DomainEvent` envelope. */
  async function envelopeFor(eventType: string, aggregateId?: string) {
    const rows = await ctx.prisma.outbox.findMany({
      where: { eventType, ...(aggregateId ? { aggregateId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[rows.length - 1];
    const envelope = row.payload as {
      id: string;
      type: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      occurredAt: string;
    };
    // Envelope-level assertions, shared by every event (domain-event-catalog.md's envelope shape,
    // adapted to this codebase's actual `DomainEvent`/outbox convention — no `version`/
    // `correlationId` fields exist anywhere in this codebase yet, Module 02/03 included, so their
    // absence here is not a Module 04-specific defect).
    expect(envelope.id).toEqual(expect.any(String));
    expect(envelope.type).toBe(eventType);
    expect(envelope.aggregateType).toEqual(expect.any(String));
    expect(envelope.aggregateId).toEqual(expect.any(String));
    expect(() => new Date(envelope.occurredAt).toISOString()).not.toThrow();
    expect(new Date(envelope.occurredAt).toISOString()).toBe(envelope.occurredAt);
    expect(row.aggregateType).toBe(envelope.aggregateType);
    expect(row.aggregateId).toBe(envelope.aggregateId);
    return envelope;
  }

  async function activeCatalogProduct(ctxLocal: TestContext) {
    const admin = await createUserWithRole(ctxLocal, 'ADMIN');
    const mfr = body(
      await request(ctxLocal.server)
        .post('/admin/catalog/manufacturers')
        .set(...auth(admin.accessToken))
        .send({ name: 'Acme Pharma' })
        .expect(201),
    );
    const product = body(
      await request(ctxLocal.server)
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
    // Published only through catalogue review (module-16 Work 30): submit (DRAFT -> PENDING_REVIEW), then approve (-> ACTIVE).
    await request(ctxLocal.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(admin.accessToken)).expect(200);
    await request(ctxLocal.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(admin.accessToken)).expect(200);
    return product.id as string;
  }

  it('PharmacyActivated: pharmacy.pharmacy.activated carries { pharmacyId, organizationId } (spec §9)', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);

    const envelope = await envelopeFor('pharmacy.pharmacy.activated', pharmacy.pharmacyId);
    expect(envelope.aggregateType).toBe('Pharmacy');
    expect(envelope.payload.pharmacyId).toBe(pharmacy.pharmacyId);
    expect(envelope.payload.organizationId).toBe(pharmacy.organizationId);
    expect(typeof envelope.payload.pharmacyId).toBe('string');
    expect(typeof envelope.payload.organizationId).toBe('string');
  });

  it('PharmacySuspended: pharmacy.pharmacy.suspended carries { pharmacyId, reason } on license-expiry sweep (spec §9)', async () => {
    const pharmacy = await createActivatedPharmacy(ctx, {
      licenseExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const sweeper = ctx.app.get(LicenseExpirySweeper);
    await sweeper.run();

    const envelope = await envelopeFor('pharmacy.pharmacy.suspended', pharmacy.pharmacyId);
    expect(envelope.aggregateType).toBe('Pharmacy');
    expect(envelope.payload.pharmacyId).toBe(pharmacy.pharmacyId);
    expect(envelope.payload.reason).toBe('LICENSE_EXPIRED');
    expect(['LICENSE_EXPIRED', 'MANUAL']).toContain(envelope.payload.reason);
  });

  it('ListingCreated + StockReceived: pharmacy.listing.created / pharmacy.stock.received on POST /inventory/listings (spec §9)', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );
    const expiryDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const created = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productId,
          branchId: branch.branchId,
          price: 1234,
          batchNumber: 'B-1',
          initialQuantity: 42,
          expiryDate,
        })
        .expect(201),
    );
    const listingId = created.listingId as string;

    const listingCreated = await envelopeFor('pharmacy.listing.created', listingId);
    expect(listingCreated.aggregateType).toBe('InventoryListing');
    expect(listingCreated.payload).toMatchObject({
      listingId,
      catalogProductId: productId,
      branchId: branch.branchId,
      pharmacyId: pharmacy.pharmacyId,
    });
    expect(typeof listingCreated.payload.price).toBe('number');
    expect(listingCreated.payload.price).toBe(1234);

    const stockReceived = await envelopeFor('pharmacy.stock.received', listingId);
    expect(stockReceived.aggregateType).toBe('InventoryListing');
    expect(stockReceived.payload.listingId).toBe(listingId);
    expect(typeof stockReceived.payload.batchId).toBe('string');
    expect(stockReceived.payload.quantity).toBe(42);
    expect(typeof stockReceived.payload.quantity).toBe('number');
    expect(stockReceived.payload.expiryDate).toBe(expiryDate);
    expect(() => new Date(stockReceived.payload.expiryDate as string).toISOString()).not.toThrow();
  });

  it('PriceChanged: pharmacy.listing.price_changed carries { listingId, oldPrice, newPrice } (spec §9)', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct(ctx);
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
    const listingId = created.listingId as string;

    await request(ctx.server)
      .patch(`/inventory/listings/${listingId}`)
      .set(...auth(pharmacy.accessToken))
      .send({ price: 150 })
      .expect(200);

    const envelope = await envelopeFor('pharmacy.listing.price_changed', listingId);
    expect(envelope.aggregateType).toBe('InventoryListing');
    expect(envelope.payload).toMatchObject({ listingId, oldPrice: 100, newPrice: 150 });
    expect(typeof envelope.payload.oldPrice).toBe('number');
    expect(typeof envelope.payload.newPrice).toBe('number');
  });

  it('ListingDisabled: pharmacy.listing.disabled carries { listingId } on PATCH isEnabled:false (spec §9)', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct(ctx);
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
    const listingId = created.listingId as string;

    await request(ctx.server)
      .patch(`/inventory/listings/${listingId}`)
      .set(...auth(pharmacy.accessToken))
      .send({ isEnabled: false })
      .expect(200);

    const envelope = await envelopeFor('pharmacy.listing.disabled', listingId);
    expect(envelope.aggregateType).toBe('InventoryListing');
    expect(Object.keys(envelope.payload)).toEqual(['listingId']);
    expect(envelope.payload.listingId).toBe(listingId);
  });

  it('StockReserved / StockReleased / StockDispatched: pharmacy.stock.* carry the reserve/release/dispatch fields from spec §9', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct(ctx);
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
          initialQuantity: 20,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    const listingId = created.listingId as string;

    const inventoryPort = ctx.app.get<IInventoryPort>(INVENTORY_PORT);

    const orderId = 'order-' + Math.random().toString(36).slice(2);
    const reserved = await inventoryPort.reserve({
      listingId,
      quantity: 5,
      orderId,
      idempotencyKey: 'idem-1',
    });

    const reservedEnvelope = await envelopeFor('pharmacy.stock.reserved', listingId);
    expect(reservedEnvelope.aggregateType).toBe('InventoryListing');
    expect(reservedEnvelope.payload).toMatchObject({
      listingId,
      reservationId: reserved.reservationId,
      orderId,
      quantity: 5,
    });
    expect(typeof reservedEnvelope.payload.quantity).toBe('number');

    await inventoryPort.release({ reservationId: reserved.reservationId, reason: 'customer_cancelled' });
    const releasedEnvelope = await envelopeFor('pharmacy.stock.released', listingId);
    expect(releasedEnvelope.aggregateType).toBe('InventoryListing');
    expect(releasedEnvelope.payload).toMatchObject({
      listingId,
      reservationId: reserved.reservationId,
      quantity: 5,
      reason: 'customer_cancelled',
    });

    // Dispatch requires a CONFIRMED reservation — reserve again, confirm, then dispatch.
    const reserved2 = await inventoryPort.reserve({
      listingId,
      quantity: 3,
      orderId,
      idempotencyKey: 'idem-2',
    });
    await inventoryPort.confirm({ reservationId: reserved2.reservationId });
    await inventoryPort.dispatch({ reservationId: reserved2.reservationId });

    const dispatchedEnvelope = await envelopeFor('pharmacy.stock.dispatched', listingId);
    expect(dispatchedEnvelope.aggregateType).toBe('InventoryListing');
    expect(dispatchedEnvelope.payload.listingId).toBe(listingId);
    expect(dispatchedEnvelope.payload.orderId).toBe(orderId);
    expect(dispatchedEnvelope.payload.quantity).toBe(3);
    expect(Array.isArray(dispatchedEnvelope.payload.batchAllocations)).toBe(true);
    const allocations = dispatchedEnvelope.payload.batchAllocations as Array<{
      batchId: string;
      qty: number;
    }>;
    expect(allocations.length).toBeGreaterThan(0);
    for (const allocation of allocations) {
      expect(typeof allocation.batchId).toBe('string');
      expect(typeof allocation.qty).toBe('number');
    }
  });
});
