import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import {
  IReservationRepository,
  RESERVATION_REPOSITORY,
} from '../../src/modules/pharmacy-inventory/domain/repositories/reservation.repository';
import { ReservationTtlSweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/reservation-ttl.sweeper';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

/**
 * Work 55 (H1) against real PostgreSQL: a listing cannot be soft-deleted while a reservation may
 * still need it — `HELD`, or `CONFIRMED` without a `DISPATCH` movement naming it (a dispatch that
 * predates `stock_movements.reservationId` counts as live). The check runs under the listing's row
 * lock, the lock `ReserveStockCommand` takes before creating a reservation; both interleavings are
 * forced by parking one flow while it holds that lock and waiting until PostgreSQL reports the other
 * blocked on `inventory_listings`.
 */
describe('Listing deletion guard (e2e, Work 55 H1)', () => {
  let ctx: TestContext;
  let inventory: IInventoryPort;
  let reservations: IReservationRepository;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestApp();
    inventory = ctx.app.get<IInventoryPort>(INVENTORY_PORT);
    reservations = ctx.app.get<IReservationRepository>(RESERVATION_REPOSITORY);
    // This suite runs the TTL sweeper by hand; no background tick may run.
    for (const job of ctx.app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
    expect([...ctx.app.get(SchedulerRegistry).getCronJobs().values()].filter((job) => job.running)).toEqual([]);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function seedListing(quantity = 20) {
    seq += 1;
    const pharmacy = await createActivatedPharmacy(ctx);
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const mfr = body(await request(ctx.server).post('/admin/catalog/manufacturers').set(...auth(admin.accessToken)).send({ name: `Maker ${seq}` }).expect(201));
    const product = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(admin.accessToken))
        .send({
          type: 'MEDICINE', genericName: `Generic ${seq}`, manufacturerId: mfr.id, dosageForm: 'TABLET',
          strengthValue: 500, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: `Product ${seq}`,
        })
        .expect(201),
    );
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(admin.accessToken)).expect(200);
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(admin.accessToken)).expect(200);
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
    return { listingId: listing.listingId as string, token: pharmacy.accessToken };
  }

  const reserve = async (listingId: string, quantity = 2) =>
    (await inventory.reserve({ listingId, quantity, orderId: `order-${++seq}`, idempotencyKey: `idem-del-${seq}` })).reservationId;
  const del = (l: { listingId: string; token: string }) => request(ctx.server).delete(`/inventory/listings/${l.listingId}`).set(...auth(l.token));
  const deletedAt = async (listingId: string) => (await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } })).deletedAt;

  async function expectBlocked(l: { listingId: string; token: string }, live: number) {
    const res = await del(l).expect(409);
    expect(errorOf(res).code).toBe(ErrorCode.CONFLICT);
    expect((res.body as { error: { details?: unknown } }).error.details).toMatchObject({ reason: 'LISTING_HAS_LIVE_RESERVATIONS', liveReservations: live });
    expect(await deletedAt(l.listingId)).toBeNull();
    expect(await ctx.prisma.auditLog.count({ where: { action: 'LISTING_DELETED', resourceId: l.listingId } })).toBe(0);
  }

  it('ordinary deletion is unchanged: no reservations → 204, soft-deleted with its audit entry', async () => {
    const l = await seedListing();
    await del(l).expect(204);
    expect(await deletedAt(l.listingId)).not.toBeNull();
    expect(await ctx.prisma.auditLog.count({ where: { action: 'LISTING_DELETED', resourceId: l.listingId } })).toBe(1);
  });

  it('a HELD reservation blocks deletion (409); once released, deletion succeeds', async () => {
    const l = await seedListing();
    const held = await reserve(l.listingId);
    await expectBlocked(l, 1);
    await inventory.release({ reservationId: held, reason: 'test' });
    await del(l).expect(204);
  });

  it('an undispatched CONFIRMED reservation blocks deletion (409)', async () => {
    const l = await seedListing();
    await inventory.confirm({ reservationId: await reserve(l.listingId) });
    await expectBlocked(l, 1);
  });

  it('only positively dispatched, released and expired reservations remain → deletion is allowed', async () => {
    const l = await seedListing();
    const dispatched = await reserve(l.listingId, 3);
    await inventory.confirm({ reservationId: dispatched });
    await inventory.dispatch({ reservationId: dispatched });
    await inventory.release({ reservationId: await reserve(l.listingId), reason: 'test' });
    const lapsed = await reserve(l.listingId);
    await ctx.prisma.stockReservation.update({ where: { id: lapsed }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    expect(await ctx.app.get(ReservationTtlSweeper).run()).toBe(1);
    expect((await ctx.prisma.stockReservation.findMany({ where: { listingId: l.listingId } })).map((r) => r.status).sort()).toEqual(['CONFIRMED', 'EXPIRED', 'RELEASED']);

    await del(l).expect(204);
    expect(await deletedAt(l.listingId)).not.toBeNull();
  });

  it('a historical DISPATCH movement without reservationId does not count as proof: the CONFIRMED reservation stays live (409)', async () => {
    const l = await seedListing();
    await inventory.confirm({ reservationId: await reserve(l.listingId) });
    await ctx.prisma.stockMovement.create({ data: { listingId: l.listingId, type: 'DISPATCH', quantityDelta: -2, refType: 'ORDER', refId: 'legacy', reservationId: null } });
    await expectBlocked(l, 1);
  });

  /** Waits until PostgreSQL reports a backend blocked on a lock while touching `inventory_listings`. */
  async function waitForListingLockWaiter() {
    for (let i = 0; i < 400; i += 1) {
      const [row] = await ctx.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE '%inventory_listings%'`;
      if (row.n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the competing flow never blocked on the listing row lock');
  }

  /** Parks the next call of `reservations[method]` — reached only while its caller holds the listing lock. */
  function pause<K extends 'countLiveForListing' | 'create'>(method: K) {
    const original = (reservations[method] as (...a: unknown[]) => Promise<unknown>).bind(reservations);
    let reached!: () => void;
    let resume!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (resume = r));
    jest.spyOn(reservations, method).mockImplementationOnce((async (...args: unknown[]) => {
      reached();
      await gate;
      return original(...args);
    }) as never);
    return { at, resume };
  }

  it('race — deletion holds the listing lock first: a concurrent reserve waits, then finds the listing deleted; no reservation is created', async () => {
    const l = await seedListing();
    const p = pause('countLiveForListing');
    const deleting = del(l).then((r) => r);
    await p.at; // the deleting transaction holds the listing row lock
    const reserving = inventory.reserve({ listingId: l.listingId, quantity: 2, orderId: 'race-order', idempotencyKey: 'race-idem' }).then(() => 'OK', (e: { code?: string }) => e.code);
    await waitForListingLockWaiter();
    p.resume();

    expect((await deleting).status).toBe(204);
    expect(await reserving).toBe('LISTING_NOT_FOUND');
    expect(await ctx.prisma.stockReservation.count({ where: { listingId: l.listingId } })).toBe(0);
    expect((await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: l.listingId } })).reserved).toBe(0);
  });

  it('race — a reserve holds the listing lock first: deletion waits, then sees the new HELD reservation and is refused', async () => {
    const l = await seedListing();
    const p = pause('create');
    const reserving = inventory.reserve({ listingId: l.listingId, quantity: 2, orderId: 'race-order', idempotencyKey: 'race-idem' });
    await p.at; // the reserving transaction holds the listing row lock, about to insert
    const deleting = del(l).then((r) => r);
    await waitForListingLockWaiter();
    p.resume();

    await reserving;
    const res = await deleting;
    expect(res.status).toBe(409);
    expect((res.body as { error: { details?: unknown } }).error.details).toMatchObject({ reason: 'LISTING_HAS_LIVE_RESERVATIONS', liveReservations: 1 });
    expect(await deletedAt(l.listingId)).toBeNull();
    expect((await ctx.prisma.stockReservation.findMany({ where: { listingId: l.listingId } })).map((r) => r.status)).toEqual(['HELD']);
  });
});
