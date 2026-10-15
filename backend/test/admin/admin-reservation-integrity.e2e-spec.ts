import { SchedulerRegistry } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { ConfirmReservationCommand } from '../../src/modules/pharmacy-inventory/application/commands/confirm-reservation.command';
import { ReserveStockCommand } from '../../src/modules/pharmacy-inventory/application/commands/reserve-stock.command';
import { ReservationTtlSweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/reservation-ttl.sweeper';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder } from '../orders/support';
import { createActivatedPharmacy } from '../pharmacy-inventory/support';

type User = RegisteredUser & Tokens;
type Row = {
  listingId: string; pharmacyId: string; branchId: string; catalogProductId: string;
  storedReserved: number; reservationDerivedReserved: number; difference: number; contributingReservations: number;
};
type Page = { generatedAt: string; items: Row[]; total: number; page: number; size: number };
type Summary = { generatedAt: string; listingsChecked: number; listingsConsistent: number; listingsWithDiscrepancy: number; listingsUndetermined: number };
const BASE = '/admin/operations/inventory/reservation-integrity';

/**
 * Module 16 Work 54 against real PostgreSQL: `inventory_listings.reserved` vs the reservation-derived
 * counter. Reservation states are produced by Module 04's own paths (checkout reserve+confirm, the
 * pharmacy's dispatch, a customer cancellation's release, `ReserveStockCommand`, Work 53's confirm-time
 * expiry, the TTL sweeper). The only hand-made rows are the two things production can no longer write:
 * a drifted counter (`reserved` edited directly) and a pre-migration `DISPATCH` movement without
 * `reservationId`. Expectations are checked twice: against the writer story told here, and against a
 * per-listing recount from the persisted rows.
 */
describe('Admin inventory reservation consistency diagnostics (e2e)', () => {
  let ctx: TestContext;
  let admin: User;

  beforeAll(async () => {
    ctx = await createTestApp();
    // The app's own @Cron ticks (the minutely TTL sweep among them) would expire seeded holds behind the
    // test's back; this suite drives the sweeper itself, so every scheduled job is stopped.
    for (const job of ctx.app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
    expect([...ctx.app.get(SchedulerRegistry).getCronJobs().values()].filter((job) => job.running)).toEqual([]);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const get = (path: string, query: Record<string, string | number> = {}, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(path).query(query);
    return token ? r.set(...auth(token)) : r;
  };
  const list = async (query: Record<string, string | number> = {}) => body(await get(BASE, { size: 100, ...query }).expect(200)) as unknown as Page;
  const summary = async (query: Record<string, string> = {}) => body(await get(`${BASE}/summary`, query).expect(200)) as unknown as Summary;

  let seq = 0;
  async function seedListing(quantity = 20) {
    seq += 1;
    const pharmacy = await createActivatedPharmacy(ctx);
    const catalogAdmin = await createUserWithRole(ctx, 'ADMIN');
    const mfr = body(await request(ctx.server).post('/admin/catalog/manufacturers').set(...auth(catalogAdmin.accessToken)).send({ name: `Maker ${seq}` }).expect(201));
    const product = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(catalogAdmin.accessToken))
        .send({
          type: 'MEDICINE', genericName: `Generic ${seq}`, manufacturerId: mfr.id, dosageForm: 'TABLET',
          strengthValue: 500, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: `Product ${seq}`,
        })
        .expect(201),
    );
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(catalogAdmin.accessToken)).expect(200);
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(catalogAdmin.accessToken)).expect(200);
    const branch = body(await request(ctx.server).post('/pharmacy/branches').set(...auth(pharmacy.accessToken)).send({ name: `Branch ${seq}` }).expect(201));
    const listing = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: product.id, branchId: branch.branchId, price: 900, batchNumber: `B-${seq}`,
          initialQuantity: quantity, expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    return { listingId: listing.listingId as string, pharmacy };
  }

  const reserve = async (listingId: string, quantity: number) =>
    (await ctx.app.get(ReserveStockCommand).execute({ listingId, quantity, orderId: randomUUID(), idempotencyKey: `idem-SECRET-${randomUUID()}` })).reservationId;
  const confirm = (reservationId: string) => ctx.app.get(ConfirmReservationCommand).execute({ reservationId });
  const lapse = (reservationId: string) => ctx.prisma.stockReservation.update({ where: { id: reservationId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  const storedOf = async (listingId: string) => (await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } })).reserved;
  /** Checkout reserves before the order row exists; the order line records which reservation it took. */
  const listingOfOrder = async (orderId: string) => {
    const line = await ctx.prisma.orderLine.findFirstOrThrow({ where: { orderId } });
    return (await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id: line.reservationId! } })).listingId;
  };
  /** A movement as written before `stock_movements.reservationId` existed. */
  const legacyDispatch = (listingId: string) =>
    ctx.prisma.stockMovement.create({ data: { listingId, type: 'DISPATCH', quantityDelta: -1, refType: 'ORDER', refId: 'legacy-order', reservationId: null } });

  /**
   * Recount from persisted rows, per Module 04's writers: HELD contributes; CONFIRMED contributes until
   * a DISPATCH movement names it; RELEASED/EXPIRED never. Undetermined if an undispatched CONFIRMED sits
   * beside a DISPATCH movement with no reservationId.
   */
  async function recount() {
    const out = new Map<string, { stored: number; derived: number; n: number; undetermined: boolean }>();
    for (const l of await ctx.prisma.inventoryListing.findMany({ where: { deletedAt: null } })) {
      const reservations = await ctx.prisma.stockReservation.findMany({ where: { listingId: l.id } });
      let derived = 0;
      let n = 0;
      let openConfirmed = false;
      for (const r of reservations) {
        const dispatched = (await ctx.prisma.stockMovement.count({ where: { reservationId: r.id, type: 'DISPATCH' } })) > 0;
        if (r.status === 'HELD' || (r.status === 'CONFIRMED' && !dispatched)) {
          derived += r.quantity;
          n += 1;
        }
        if (r.status === 'CONFIRMED' && !dispatched) openConfirmed = true;
      }
      const legacy = (await ctx.prisma.stockMovement.count({ where: { listingId: l.id, type: 'DISPATCH', reservationId: null } })) > 0;
      out.set(l.id, { stored: l.reserved, derived, n, undetermined: openConfirmed && legacy });
    }
    return out;
  }

  describe('a seeded population', () => {
    let w: Record<string, string>;
    let owners: Record<string, string>;
    let secrets: string[];

    beforeAll(async () => {
      await ctx.reset();
      admin = await createUserWithRole(ctx, 'ADMIN');
      // empty — no reservations, stored 0.
      const empty = await seedListing();
      // dispatched — checkout reserve+confirm, then the pharmacy dispatches it (stays CONFIRMED).
      const a = await placeOrder(ctx);
      for (const action of ['accept', 'prepare', 'ready']) {
        await request(ctx.server).post(`/pharmacy/orders/${a.fulfillmentId}/${action}`).set(...auth(a.pharmacy.accessToken)).expect(200);
      }
      // released — checkout, then the customer cancels.
      const b = await placeOrder(ctx);
      await request(ctx.server).post(`/orders/${b.orderId}/cancel`).set(...auth(b.customer.accessToken)).send({ reason: 'Changed my mind about it' }).expect(200);
      // mixed — HELD 2; HELD 1 past expiresAt but not swept (still counted); CONFIRMED 4 undispatched;
      // HELD 3 lapsed then confirmed → Work 53 expires it in confirm's own transaction.
      const mixed = await seedListing();
      await reserve(mixed.listingId, 2);
      await lapse(await reserve(mixed.listingId, 1));
      await confirm(await reserve(mixed.listingId, 4));
      const lapsed = await reserve(mixed.listingId, 3);
      await lapse(lapsed);
      await expect(confirm(lapsed)).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
      // positive drift — HELD 2, counter then drifted +3.
      const positive = await seedListing();
      await reserve(positive.listingId, 2);
      await ctx.prisma.inventoryListing.update({ where: { id: positive.listingId }, data: { reserved: { increment: 3 } } });
      // negative drift — CONFIRMED 4, counter then drifted −1.
      const negative = await seedListing();
      await confirm(await reserve(negative.listingId, 4));
      await ctx.prisma.inventoryListing.update({ where: { id: negative.listingId }, data: { reserved: { decrement: 1 } } });
      // undetermined — CONFIRMED 2 undispatched beside a legacy DISPATCH with no reservationId.
      const undetermined = await seedListing();
      await confirm(await reserve(undetermined.listingId, 2));
      await legacyDispatch(undetermined.listingId);
      // legacy but determinable — only a HELD reservation, so the legacy DISPATCH cannot have consumed it.
      const legacyHeld = await seedListing();
      await reserve(legacyHeld.listingId, 2);
      await legacyDispatch(legacyHeld.listingId);
      // deleted — a drifted counter on a soft-deleted listing: outside the population.
      const deleted = await seedListing();
      await reserve(deleted.listingId, 2);
      await ctx.prisma.inventoryListing.update({ where: { id: deleted.listingId }, data: { reserved: 9 } });
      await request(ctx.server).delete(`/inventory/listings/${deleted.listingId}`).set(...auth(deleted.pharmacy.accessToken)).expect((r) => expect([200, 204]).toContain(r.status));

      w = {
        empty: empty.listingId, dispatched: await listingOfOrder(a.orderId), released: await listingOfOrder(b.orderId), mixed: mixed.listingId, lapsed,
        positive: positive.listingId, negative: negative.listingId, undetermined: undetermined.listingId, legacyHeld: legacyHeld.listingId, deleted: deleted.listingId,
      };
      owners = { positivePharmacy: (await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: positive.listingId } })).pharmacyId, ownerToken: positive.pharmacy.accessToken };
      const reservations = await ctx.prisma.stockReservation.findMany();
      secrets = [
        ...reservations.map((r) => r.id), ...reservations.flatMap((r) => [r.orderId, r.idempotencyKey]).filter((x): x is string => !!x),
        a.orderId, b.orderId, a.customer.userId, b.customer.userId, a.pharmacy.userId, 'idem-SECRET', 'legacy-order', 'Changed my mind',
      ];
    });

    it('the writer story holds in the persisted rows (stored counters and statuses as Module 04 left them)', async () => {
      expect(await storedOf(w.empty)).toBe(0);
      expect(await storedOf(w.dispatched)).toBe(0);
      expect(await storedOf(w.released)).toBe(0);
      expect(await storedOf(w.mixed)).toBe(2 + 1 + 4); // the lapsed 3 was released by confirm's expiry
      expect(await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id: w.lapsed } })).toMatchObject({ status: 'EXPIRED' });
      expect(await ctx.prisma.stockMovement.count({ where: { reservationId: w.lapsed, type: 'RELEASE' } })).toBe(1);
      expect([await storedOf(w.positive), await storedOf(w.negative), await storedOf(w.undetermined), await storedOf(w.legacyHeld)]).toEqual([5, 3, 2, 2]);
    });

    it('lists exactly the discrepant live listings, largest |difference| first, field for field against the recount', async () => {
      const res = await list();
      expect(res.items.map((r) => r.listingId)).toEqual([w.positive, w.negative]);
      expect(res.total).toBe(2);
      expect(res.items[0]).toMatchObject({ storedReserved: 5, reservationDerivedReserved: 2, difference: 3, contributingReservations: 1 });
      expect(res.items[1]).toMatchObject({ storedReserved: 3, reservationDerivedReserved: 4, difference: -1, contributingReservations: 1 });
      const counts = await recount();
      for (const item of res.items) {
        const l = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: item.listingId } });
        const c = counts.get(item.listingId)!;
        expect(item).toEqual({
          listingId: l.id, pharmacyId: l.pharmacyId, branchId: l.branchId, catalogProductId: l.catalogProductId,
          storedReserved: c.stored, reservationDerivedReserved: c.derived, difference: c.stored - c.derived, contributingReservations: c.n,
        });
      }
      const expectedIds = [...counts].filter(([, c]) => !c.undetermined && c.stored !== c.derived).map(([id]) => id).sort();
      expect(res.items.map((r) => r.listingId).sort()).toEqual(expectedIds);
      expect(Date.parse(res.generatedAt)).not.toBeNaN();
    });

    it('summary: every live listing classified once; agrees with the list and with the persisted population', async () => {
      const s = await summary();
      const counts = await recount();
      const live = await ctx.prisma.inventoryListing.count({ where: { deletedAt: null } });
      expect(s.listingsChecked).toBe(live);
      expect(s.listingsChecked).toBe(counts.size);
      expect(s.listingsWithDiscrepancy).toBe((await list()).total);
      expect(s).toMatchObject({
        listingsConsistent: [...counts.values()].filter((c) => !c.undetermined && c.stored === c.derived).length,
        listingsWithDiscrepancy: 2,
        listingsUndetermined: 1,
      });
      expect(s.listingsConsistent + s.listingsWithDiscrepancy + s.listingsUndetermined).toBe(s.listingsChecked);
      // The named listings, by class: dispatched/released/mixed/legacy-but-HELD are consistent, the legacy CONFIRMED one is not.
      for (const id of [w.empty, w.dispatched, w.released, w.mixed, w.legacyHeld]) expect(counts.get(id)).toMatchObject({ undetermined: false });
      expect(counts.get(w.undetermined)).toMatchObject({ stored: 2, derived: 2, undetermined: true }); // equal, yet not called consistent
      expect(counts.has(w.deleted)).toBe(false);
      expect((await list()).items.map((r) => r.listingId)).not.toContain(w.deleted);
      expect((await list()).items.map((r) => r.listingId)).not.toContain(w.undetermined);
    });

    it('scoping by pharmacy or branch narrows both endpoints alike; pages are stable', async () => {
      const positive = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: w.positive } });
      expect(await summary({ pharmacyId: owners.positivePharmacy })).toMatchObject({ listingsChecked: 1, listingsWithDiscrepancy: 1, listingsConsistent: 0 });
      expect((await list({ branchId: positive.branchId })).items.map((r) => r.listingId)).toEqual([w.positive]);
      const mixed = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: w.mixed } });
      expect(await summary({ pharmacyId: mixed.pharmacyId })).toMatchObject({ listingsChecked: 1, listingsConsistent: 1 });
      expect((await list({ pharmacyId: mixed.pharmacyId })).total).toBe(0);
      expect(await summary({ pharmacyId: randomUUID() })).toMatchObject({ listingsChecked: 0, listingsConsistent: 0, listingsWithDiscrepancy: 0, listingsUndetermined: 0 });
      const [p1, p2] = [await list({ size: 1, page: 1 }), await list({ size: 1, page: 2 })];
      expect([...p1.items, ...p2.items].map((r) => r.listingId)).toEqual([w.positive, w.negative]);
      expect([p1.total, p2.total, (await list({ size: 1, page: 3 })).items]).toEqual([2, 2, []]);
    });

    it('validation and routing: UUID scope, bounded paging, no other parameters; summary is never an id; unknown paths 404', async () => {
      for (const bad of <Array<Record<string, string | number>>>[
        { pharmacyId: 'x' }, { branchId: 'L-1' }, { page: 0 }, { size: 101 }, { listingId: w.positive }, { reservationId: randomUUID() }, { orderId: 'o' }, { repair: 'true' },
      ]) {
        expect({ bad, status: (await get(BASE, bad)).status }).toEqual({ bad, status: 400 });
      }
      expect((await get(`${BASE}/summary`, { page: 1 })).status).toBe(400);
      expect((await get(`${BASE}/summary`, { pharmacyId: 'nope' })).status).toBe(400);
      await get(`${BASE}/summary`).expect(200);
      expect((await get(`${BASE}/${w.positive}`)).status).toBe(404);
      expect((await get(`${BASE}/not-a-uuid`)).status).toBe(404);
    });

    it('privacy: listing-level quantities only — no reservation, order, customer, owner, key or reason', async () => {
      const raw = JSON.stringify([await list(), await summary(), await list({ pharmacyId: owners.positivePharmacy })]);
      for (const secret of secrets) expect({ secret: secret.slice(0, 14), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 14), found: false });
      expect(raw).not.toMatch(/"(reservationId|reservationIds|orderId|idempotencyKey|customerUserId|userId|reason|expiresAt|status|actorUserId)"/);
      expect(Object.keys((await list()).items[0]).sort()).toEqual(
        ['branchId', 'catalogProductId', 'contributingReservations', 'difference', 'listingId', 'pharmacyId', 'reservationDerivedReserved', 'storedReserved'],
      );
    });

    it('read-only: listings, reservations, batches, movements, audit and outbox unchanged; other methods 404; Works 49–52 unchanged', async () => {
      const state = async () => ({
        listings: await ctx.prisma.inventoryListing.findMany({ orderBy: { id: 'asc' } }),
        reservations: await ctx.prisma.stockReservation.findMany({ orderBy: { id: 'asc' } }),
        batches: await ctx.prisma.stockBatch.findMany({ orderBy: { id: 'asc' } }),
        movements: await ctx.prisma.stockMovement.findMany({ orderBy: { id: 'asc' } }),
        audit: await ctx.prisma.auditLog.count(),
        outbox: await ctx.prisma.outbox.count(),
      });
      const before = await state();
      await list();
      await summary();
      await list({ pharmacyId: owners.positivePharmacy });
      for (const [method, path] of [['post', BASE], ['put', BASE], ['patch', BASE], ['delete', BASE], ['post', `${BASE}/summary`], ['post', `${BASE}/repair`]] as const) {
        expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ reserved: 0 })).status }).toEqual({ method, path, status: 404 });
      }
      expect(await state()).toEqual(before);
      // Work 49's listing detail still reports the stored column this view calls storedReserved.
      const detail = body(await get(`/admin/operations/inventory/listings/${w.positive}`).expect(200)) as { reserved: number };
      expect(detail.reserved).toBe(5);
      await get('/admin/operations/inventory/movements', { listingId: w.mixed }).expect(200);
      await get('/admin/operations/inventory/batches', { listingId: w.mixed }).expect(200);
      const reservations = body(await get('/admin/operations/inventory/reservations', { listingId: w.mixed, size: 100 }).expect(200)) as { items: Array<{ status: string }> };
      expect(reservations.items.map((r) => r.status).sort()).toEqual(['CONFIRMED', 'EXPIRED', 'HELD', 'HELD']);
    });

    it('RBAC: ADMIN and SUPER_ADMIN allowed; anonymous 401; pharmacy roles (even the drifted listing’s owner) and others 403', async () => {
      const paths = [BASE, `${BASE}/summary`];
      const sup = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
      for (const path of paths) {
        expect((await get(path, {}, null)).status).toBe(401);
        expect((await get(path, {}, sup)).status).toBe(200);
      }
      const tokens: Array<[string, string]> = [['PHARMACY_OWNER (own listing)', owners.ownerToken]];
      for (const role of ['PHARMACY_MANAGER', 'INVENTORY_STAFF', 'DRIVER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
      for (const [role, token] of tokens) {
        for (const path of paths) expect({ role, path, status: (await get(path, {}, token)).status }).toEqual({ role, path, status: 403 });
      }
    });
  });

  describe('fresh state', () => {
    beforeEach(async () => {
      await ctx.reset();
      admin = await createUserWithRole(ctx, 'ADMIN');
    });

    it('an empty population: zero everywhere, empty list', async () => {
      expect(await summary()).toMatchObject({ listingsChecked: 0, listingsConsistent: 0, listingsWithDiscrepancy: 0, listingsUndetermined: 0 });
      const res = body(await get(BASE).expect(200)) as unknown as Page;
      expect([res.items, res.total, res.page, res.size]).toEqual([[], 0, 1, 20]);
    });

    it('Work 53 cleanup moves both sides by exactly the lapsed quantity, once: a lapsed HELD counts until its expiry commits; neither confirm nor a later sweep double-releases', async () => {
      const { listingId } = await seedListing();
      await reserve(listingId, 2);
      const lapsed = await reserve(listingId, 3);
      await lapse(lapsed);
      const scope = { pharmacyId: (await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } })).pharmacyId };
      // Before cleanup: the lapsed hold is still HELD, so it still contributes — consistent at 5.
      expect(await summary(scope)).toMatchObject({ listingsChecked: 1, listingsConsistent: 1 });
      expect((await recount()).get(listingId)).toMatchObject({ stored: 5, derived: 5, n: 2 });

      await expect(confirm(lapsed)).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
      expect((await recount()).get(listingId)).toMatchObject({ stored: 2, derived: 2, n: 1 });
      expect(await summary(scope)).toMatchObject({ listingsConsistent: 1, listingsWithDiscrepancy: 0 });

      expect(await ctx.app.get(ReservationTtlSweeper).run()).toBe(0);
      await expect(confirm(lapsed)).rejects.toMatchObject({ code: 'INVALID_RESERVATION_STATE' });
      expect((await recount()).get(listingId)).toMatchObject({ stored: 2, derived: 2 });
      expect(await ctx.prisma.stockMovement.count({ where: { reservationId: lapsed, type: 'RELEASE' } })).toBe(1);
      expect((await list(scope)).total).toBe(0);
    });

    it('many reservations on one listing are summed once (batches and movements do not multiply them)', async () => {
      const { listingId, pharmacy } = await seedListing(50);
      // Three batches and several movements on the same listing — a join through either would multiply quantities.
      for (const batchNumber of ['B-extra-1', 'B-extra-2']) {
        await request(ctx.server)
          .post(`/inventory/listings/${listingId}/batches`)
          .set(...auth(pharmacy.accessToken))
          .send({ batchNumber, quantity: 10, expiryDate: new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString() })
          .expect(201);
      }
      expect(await ctx.prisma.stockBatch.count({ where: { listingId } })).toBe(3);
      for (const q of [1, 2, 3, 4, 5]) await confirm(await reserve(listingId, q));
      for (const q of [6, 7]) await reserve(listingId, q);
      const pharmacyId = (await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } })).pharmacyId;
      expect(await storedOf(listingId)).toBe(28);
      expect(await ctx.prisma.stockMovement.count({ where: { listingId } })).toBeGreaterThan(7);
      expect(await summary({ pharmacyId })).toMatchObject({ listingsChecked: 1, listingsConsistent: 1 });
      await ctx.prisma.inventoryListing.update({ where: { id: listingId }, data: { reserved: 27 } });
      expect((await list({ pharmacyId })).items).toEqual([
        expect.objectContaining({ listingId, storedReserved: 27, reservationDerivedReserved: 28, difference: -1, contributingReservations: 7 }),
      ]);
    });
  });
});
