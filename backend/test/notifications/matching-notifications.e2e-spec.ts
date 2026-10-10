import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { auth, body, createUserWithRole, login, registerAndVerify, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, PharmacyOwnerContext } from '../pharmacy-inventory/support';
import { readyToCheckout } from '../orders/support';

type User = RegisteredUser & Tokens;

interface Item {
  id: string;
  type: string | null;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
}

const MATCHING_TYPES = ['MATCHING_ORDER_MATCHED', 'MATCHING_REMATCH_TRIGGERED', 'MATCHING_FAILED'];

/**
 * Module 13 Work 10 against real PostgreSQL and the real HTTP stack.
 *
 * Both events come from Module 05's own surface: the customer's `/matching/find` → `select`
 * (`matching.order_matched`) and `rematch` away from the selected pharmacy to a second stocked one
 * (`matching.rematch_triggered`, which Module 05 writes only once the rematch has succeeded). A real
 * checkout — which selects through Module 05's `MATCHING_PORT` — shows the same event from Module
 * 06's path. Events go through the real outbox relay and the customer through Work 06's real
 * `PRESCRIPTION_RECIPIENT_READ_PORT`.
 */
describe('Matching outcome notifications (e2e)', () => {
  let ctx: TestContext;
  let customerA: User;
  let customerB: User;
  let productSeq = 0;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    customerA = await newCustomer();
    customerB = await newCustomer();
  });

  async function newCustomer(): Promise<User> {
    const registered = await registerAndVerify(ctx);
    return { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
  }

  async function activeProduct(): Promise<string> {
    productSeq += 1;
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const mfr = body(
      await request(ctx.server).post('/admin/catalog/manufacturers').set(...auth(admin.accessToken)).send({ name: `Acme Pharma ${productSeq}` }).expect(201),
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
    // Published only through catalogue review (module-16 Work 30): submit (DRAFT -> PENDING_REVIEW), then approve (-> ACTIVE).
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(admin.accessToken)).expect(200);
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(admin.accessToken)).expect(200);
    return product.id as string;
  }

  async function stockedPharmacy(productId: string): Promise<PharmacyOwnerContext> {
    const pharmacy = await createActivatedPharmacy(ctx);
    const branch = body(await request(ctx.server).post('/pharmacy/branches').set(...auth(pharmacy.accessToken)).send({ name: 'Main Branch' }).expect(201));
    await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(pharmacy.accessToken))
      .send({
        catalogProductId: productId,
        branchId: branch.branchId,
        price: 300,
        batchNumber: 'B-1',
        initialQuantity: 10,
        expiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      })
      .expect(201);
    return pharmacy;
  }

  /** find → select pharmacy A (order_matched) → rematch away from A to B (rematch_triggered). */
  async function matchedThenRematched(customer: User) {
    const productId = await activeProduct();
    const pharmacyA = await stockedPharmacy(productId);
    const pharmacyB = await stockedPharmacy(productId);
    const lines = [{ catalogProductId: productId, quantity: 2 }];
    const found = body(await request(ctx.server).post('/matching/find').set(...auth(customer.accessToken)).send({ lines }).expect(201)) as unknown as {
      matchRequest: { id: string };
    };
    const matchRequestId = found.matchRequest.id;
    await request(ctx.server).post(`/matching/${matchRequestId}/select`).set(...auth(customer.accessToken)).send({ pharmacyId: pharmacyA.pharmacyId, lines }).expect(200);
    await ctx.drainOutbox();
    const afterSelect = await matchingItems(customer.accessToken);
    const rematched = body(await request(ctx.server).post(`/matching/${matchRequestId}/rematch`).set(...auth(customer.accessToken)).send({ lines }).expect(200));
    expect(rematched.status).toBe('MATCHED');
    await ctx.drainOutbox();
    return { matchRequestId, productId, pharmacyA, pharmacyB, afterSelect };
  }

  const inbox = async (token: string, query: Record<string, unknown> = {}) =>
    (body(await request(ctx.server).get('/notifications').query(query).set(...auth(token)).expect(200)) as { items: Item[] }).items;
  const matchingItems = async (token: string) => (await inbox(token)).filter((i) => MATCHING_TYPES.includes(i.type ?? ''));

  // ===========================================================================================
  // 1. The two events, through Module 05's own routes
  // ===========================================================================================

  describe('events', () => {
    it('select → customer A gets exactly one MATCHING_ORDER_MATCHED; customer B and the pharmacies get none', async () => {
      const { matchRequestId, pharmacyA, pharmacyB, afterSelect } = await matchedThenRematched(customerA);
      expect(afterSelect).toEqual([
        expect.objectContaining({
          type: 'MATCHING_ORDER_MATCHED',
          title: 'Pharmacy found',
          body: 'We found a pharmacy that can fulfil your request.',
          data: { matchRequestId },
          read: false,
        }),
      ]);
      expect(await inbox(customerB.accessToken)).toEqual([]);
      for (const pharmacy of [pharmacyA, pharmacyB]) {
        // Their inbox holds their own PHARMACY_ACTIVATED (Work 07) and nothing about the match.
        expect((await inbox(pharmacy.accessToken)).map((i) => i.type)).toEqual(['PHARMACY_ACTIVATED']);
      }
      const envelope = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'matching.order_matched', aggregateId: matchRequestId } });
      const stored = await ctx.prisma.notification.findFirstOrThrow({ where: { templateCode: 'MATCHING_ORDER_MATCHED' } });
      expect(stored).toMatchObject({ recipientUserId: customerA.userId, channel: 'IN_APP', status: 'SENT', eventType: 'matching.order_matched' });
      expect(stored.dedupeKey).toBe(`${(envelope.payload as unknown as DomainEvent).id}:${customerA.userId}`);
    });

    it('rematch → customer A gets exactly one MATCHING_REMATCH_TRIGGERED, separate from the match, in Amharic', async () => {
      await request(ctx.server).patch('/users/me').set(...auth(customerA.accessToken)).send({ preferredLanguage: 'am' }).expect(200);
      const { matchRequestId } = await matchedThenRematched(customerA);
      const items = await matchingItems(customerA.accessToken);
      expect(items.map((i) => i.type)).toEqual(['MATCHING_REMATCH_TRIGGERED', 'MATCHING_ORDER_MATCHED']);
      expect(items[0]).toMatchObject({ title: 'ወደ ሌላ ፋርማሲ ተዛውሯል', body: 'ጥያቄዎ ወደ ሌላ ፋርማሲ ተዛውሯል።', data: { matchRequestId } });
      expect(await inbox(customerB.accessToken)).toEqual([]);
    });

    it('a checkout’s own select (Module 06 → MATCHING_PORT) notifies its customer alongside ORDER_PLACED', async () => {
      const { user, addressId } = await readyToCheckout(ctx);
      await request(ctx.server).post('/checkout').set(...auth(user.accessToken)).send({ addressId, idempotencyKey: randomUUID() }).expect(201);
      await ctx.drainOutbox();
      expect((await inbox(user.accessToken)).map((i) => i.type).sort()).toEqual(['MATCHING_ORDER_MATCHED', 'ORDER_PLACED']);
    });
  });

  // ===========================================================================================
  // 2. Idempotency, inbox, privacy, audit
  // ===========================================================================================

  describe('idempotency', () => {
    it('a redelivered or concurrently delivered rematch writes one notification, beside the one match', async () => {
      const { matchRequestId } = await matchedThenRematched(customerA);
      // Module 13 is the only consumer of matching.rematch_triggered, so replaying it touches nothing else.
      for (let i = 0; i < 2; i += 1) {
        await ctx.prisma.outbox.updateMany({ where: { eventType: 'matching.rematch_triggered', aggregateId: matchRequestId }, data: { publishedAt: null } });
        await ctx.drainOutbox();
      }
      const row = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'matching.rematch_triggered', aggregateId: matchRequestId } });
      await Promise.all(Array.from({ length: 5 }, () => ctx.app.get(EventBusService).publish(row.payload as unknown as DomainEvent)));
      expect(await ctx.prisma.notification.count({ where: { templateCode: 'MATCHING_REMATCH_TRIGGERED' } })).toBe(1);
      expect(await ctx.prisma.notification.count({ where: { templateCode: 'MATCHING_ORDER_MATCHED' } })).toBe(1);
    });
  });

  describe('inbox', () => {
    it('serves them through GET /notifications; the customer marks one READ, another user cannot', async () => {
      const { pharmacyA } = await matchedThenRematched(customerA);
      const [rematch] = await matchingItems(customerA.accessToken);
      for (const other of [customerB, pharmacyA]) {
        await request(ctx.server).post(`/notifications/${rematch.id}/read`).set(...auth(other.accessToken)).send({}).expect(404);
      }
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: rematch.id } })).status).toBe('SENT');
      const read = body(await request(ctx.server).post(`/notifications/${rematch.id}/read`).set(...auth(customerA.accessToken)).send({}).expect(200));
      expect(read).toMatchObject({ id: rematch.id, type: 'MATCHING_REMATCH_TRIGGERED', read: true });
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: rematch.id } })).status).toBe('READ');
    });

    it('stores and serves no pharmacy (chosen or excluded), branch, listing, reservation, medicine or quantity data', async () => {
      const { productId, pharmacyA, pharmacyB, matchRequestId } = await matchedThenRematched(customerA);
      const listings = await ctx.prisma.inventoryListing.findMany({ select: { id: true, branchId: true } });
      const reservations = (await ctx.prisma.stockReservation.findMany({ select: { id: true } })).map((r) => r.id);
      const rematchEvent = (await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'matching.rematch_triggered', aggregateId: matchRequestId } }))
        .payload as unknown as DomainEvent<{ excludedPharmacyId: string }>;
      expect(rematchEvent.payload.excludedPharmacyId).toBe(pharmacyA.pharmacyId);

      const stored = JSON.stringify(await ctx.prisma.notification.findMany({ where: { templateCode: { in: MATCHING_TYPES } } }));
      const served = JSON.stringify(await matchingItems(customerA.accessToken));
      for (const f of [
        pharmacyA.pharmacyId, pharmacyB.pharmacyId, pharmacyA.organizationId, productId, ...listings.flatMap((l) => [l.id, l.branchId]), ...reservations,
        'excludedPharmacyId', 'pharmacyId', 'branchId', 'listingId', 'reservationId', 'catalogProductId', 'quantity', 'chosenResult', 'Amoxicillin',
        'Test Pharmacy', customerA.phone,
      ]) {
        expect({ f, stored: stored.includes(f), served: served.includes(f) }).toEqual({ f, stored: false, served: false });
      }
      expect(served).not.toContain(customerA.userId);
    });

    it('creation wrote no Module 13 audit entry; reads, count, read and read-all append none', async () => {
      await matchedThenRematched(customerA);
      expect(
        await ctx.prisma.auditLog.count({ where: { OR: [{ resourceType: { contains: 'otification' } }, { action: { contains: 'NOTIFICATION' } }] } }),
      ).toBe(0);
      const before = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      const [first] = await matchingItems(customerA.accessToken);
      await request(ctx.server).get('/notifications/unread-count').set(...auth(customerA.accessToken)).expect(200);
      await request(ctx.server).post(`/notifications/${first.id}/read`).set(...auth(customerA.accessToken)).send({}).expect(200);
      await request(ctx.server).post('/notifications/read-all').set(...auth(customerA.accessToken)).send({}).expect(200);
      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(before);
    });
  });

  describe('boundaries', () => {
    it('Module 13’s Module 05 imports are unchanged by Work 10: the recipient port, the event contract and the module', () => {
      const root = join(__dirname, '..', '..', 'src', 'modules', 'notifications');
      const imports = new Set<string>();
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
            const source = readFileSync(full, 'utf8');
            for (const forbidden of [
              'prisma.matchRequest',
              'prisma.prescription',
              'MATCH_REPOSITORY',
              'MATCHING_PORT',
              'prescription-matching/domain/repositories',
              'prescription-matching/domain/entities',
              'prescription-matching/infrastructure/',
              'prescription-matching/application/commands/',
            ]) {
              expect({ full, forbidden, found: source.includes(forbidden) }).toEqual({ full, forbidden, found: false });
            }
            for (const m of source.matchAll(/from '(?:\.\.\/)+(prescription-matching\/[^']*)'/g)) imports.add(m[1]);
          }
        }
      };
      walk(root);
      expect([...imports].sort()).toEqual([
        'prescription-matching/application/ports/inbound/prescription-recipient-read.port',
        'prescription-matching/domain/events',
        'prescription-matching/prescription-matching.module',
      ]);
    });
  });
});
