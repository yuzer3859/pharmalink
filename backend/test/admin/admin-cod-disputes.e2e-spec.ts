import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CreateDeliveryJobCommand } from '../../src/modules/delivery/application/commands/create-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { RecordCodCollectionCommand } from '../../src/modules/delivery/application/commands/record-cod-collection.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import {
  COD_DISPUTE_ADMIN_PORT,
  ICodDisputeAdminPort,
} from '../../src/modules/delivery/application/ports/inbound/cod-dispute-admin.port';
import {
  CodCollectionMethod,
  DeliveryJobStatus,
  DriverAvailability,
} from '../../src/modules/delivery/domain/enums';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const ORDER_TOTAL = 24_500;
const COLLECTED = 20_000;
const DISPUTES = '/admin/cod-disputes';
const M08 = '/admin/delivery/cod-reconciliation';

interface DisputeRow {
  id: string;
  collectionId: string;
  reason: string;
  status: string;
  openedByUserId: string;
  openedAt: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

interface ListBody {
  items: Array<{
    dispute: DisputeRow;
    collection: { id: string; jobId: string; orderId: string; driverId: string; expectedAmount: number; collectedAmount: number; currency: string; status: string };
  }>;
  total: number;
  page: number;
  size: number;
}

interface DetailBody {
  dispute: DisputeRow;
  collection: Record<string, unknown> & {
    id: string;
    collectionVariance: number;
    hasDiscrepancy: boolean;
    remittance: unknown;
    reconciliation: unknown;
    corrections: unknown[];
    disputes: DisputeRow[];
  };
}

interface ResolutionBody {
  dispute: DisputeRow;
  collectionId: string;
  previousStatus: string;
  changed: boolean;
}

/**
 * Module 16 Work 06 against real PostgreSQL and the real HTTP stack.
 *
 * What can only be shown here: that a resolution through the admin surface is Module 08's
 * resolution (its compare-and-set, its replay-or-refuse, its audit entry, and nothing about the
 * money), that the queue is the same disputes Module 08's own per-collection routes serve, and
 * that Module 08's permission split — `ADMIN` may look, only finance may close — holds here
 * exactly as it does there.
 */
describe('Admin COD dispute management (e2e)', () => {
  let ctx: TestContext;
  let createJob: CreateDeliveryJobCommand;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let recordCod: RecordCodCollectionCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let port: ICodDisputeAdminPort;

  /** `finance:settlement:any` and `finance:report:any`. */
  let finance: Awaited<ReturnType<typeof createUserWithRole>>;
  /** `finance:report:any` only. */
  let admin: Awaited<ReturnType<typeof createUserWithRole>>;

  beforeAll(async () => {
    ctx = await createTestApp();
    createJob = ctx.app.get(CreateDeliveryJobCommand);
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
    recordCod = ctx.app.get(RecordCodCollectionCommand);
    createProfile = ctx.app.get(CreateDriverProfileCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
    port = ctx.app.get<ICodDisputeAdminPort>(COD_DISPUTE_ADMIN_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — a real shortfall, recorded through Module 08's own commands
  // -------------------------------------------------------------------------------------------

  async function seedDriver() {
    const user = await createUserWithRole(ctx, 'DRIVER');
    await ctx.prisma.user.update({ where: { id: user.userId }, data: { primaryRole: 'DRIVER' } });
    await ctx.prisma.verificationRequest.create({
      data: { userId: user.userId, type: 'DRIVER_DOCS', status: 'APPROVED', reviewedAt: new Date() },
    });
    const { profile } = await createProfile.execute({
      userId: user.userId,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: `AA-${Math.floor(Math.random() * 99_999)}`,
      serviceArea: { lat: 9.03, lng: 38.74, radiusMeters: 20_000 },
    });
    await shift.start({ userId: user.userId });
    await availability.execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
    return { userId: user.userId, profileId: profile.id, accessToken: user.accessToken };
  }

  async function seedFulfillment() {
    const owner = await ctx.prisma.user.create({
      data: { primaryRole: 'PHARMACY_OWNER', status: 'ACTIVE', phone: uniquePhone() },
    });
    const organization = await ctx.prisma.organization.create({
      data: { type: 'PHARMACY', name: `Org ${randomUUID()}`, status: 'ACTIVE', ownerUserId: owner.id },
    });
    const pharmacy = await ctx.prisma.pharmacy.create({
      data: { organizationId: organization.id, displayName: 'Bole Pharmacy' },
    });
    const branch = await ctx.prisma.branch.create({
      data: { pharmacyId: pharmacy.id, name: 'Bole Branch', addressLine: 'Africa Ave', city: 'Addis Ababa', lat: 9.03, lng: 38.74 },
    });
    const product = await ctx.prisma.product.create({
      data: { type: 'MEDICINE', nameEn: 'Amoxicillin 500mg', genericName: 'Amoxicillin' },
    });
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: randomUUID(),
        status: 'PAID',
        subtotal: ORDER_TOTAL,
        grandTotal: ORDER_TOTAL,
        currency: 'ETB',
        isCod: true,
        idempotencyKey: `checkout-${randomUUID()}`,
        addressSnapshot: { line1: 'Kazanchis, Bldg 4', city: 'Addis Ababa', lat: 8.98, lng: 38.79 },
      },
    });
    const fulfillment = await ctx.prisma.fulfillment.create({
      data: { orderId: order.id, pharmacyId: pharmacy.id, branchId: branch.id, status: 'READY' },
    });
    await ctx.prisma.orderLine.create({
      data: {
        orderId: order.id,
        fulfillmentId: fulfillment.id,
        catalogProductId: product.id,
        productSnapshot: { name: 'Amoxicillin 500mg' },
        quantity: 1,
        unitPrice: ORDER_TOTAL,
        lineTotal: ORDER_TOTAL,
      },
    });
    return { fulfillmentId: fulfillment.id, orderId: order.id };
  }

  interface Scenario {
    collectionId: string;
    jobId: string;
    orderId: string;
    driverProfileId: string;
  }

  /** A delivery whose driver declared 20,000 against a 24,500 order — a real shortfall. */
  async function collected(): Promise<Scenario> {
    const driver = await seedDriver();
    const seed = await seedFulfillment();
    const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });
    await dispatch.execute({ jobId: job.id, actorUserId: null });
    await accept.execute({ userId: driver.userId, jobId: job.id });
    for (const to of [
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
    ]) {
      await advance.byDriver({ userId: driver.userId, jobId: job.id, to });
    }
    const { collection } = await recordCod.execute({
      userId: driver.userId,
      jobId: job.id,
      collectedAmount: COLLECTED,
      method: CodCollectionMethod.CASH,
    });
    // Taking the driver offline keeps the next scenario's dispatch deterministic.
    await availability.execute({ userId: driver.userId, availability: DriverAvailability.OFFLINE });
    return { collectionId: collection.id, jobId: job.id, orderId: seed.orderId, driverProfileId: driver.profileId };
  }

  /** Raised through Module 08's own route — the desk's act, not the control plane's. */
  async function opened(reason = 'Short by 4,500 at the cash desk.'): Promise<Scenario & { disputeId: string }> {
    const scenario = await collected();
    const res = await request(ctx.server)
      .post(`${M08}/${scenario.collectionId}/disputes`)
      .set(...auth(finance.accessToken))
      .send({ reason })
      .expect(200);
    return { ...scenario, disputeId: (body(res).dispute as { id: string }).id };
  }

  const list = (token: string, query: Record<string, string | number> = {}) =>
    request(ctx.server).get(DISPUTES).set(...auth(token)).query(query);
  const detail = (token: string, id: string) =>
    request(ctx.server).get(`${DISPUTES}/${id}`).set(...auth(token));
  const resolve = (token: string, id: string, payload: Record<string, unknown> = {}) =>
    request(ctx.server).post(`${DISPUTES}/${id}/resolve`).set(...auth(token)).send(payload);

  const adminAudits = () => ctx.prisma.auditLog.count({ where: { action: 'ADMIN_COD_DISPUTE_RESOLVED' } });

  // -------------------------------------------------------------------------------------------
  // 1. List
  // -------------------------------------------------------------------------------------------

  describe('list', () => {
    it('shows every dispute across collections, newest first, with the collection it questions', async () => {
      const first = await opened('First shortfall.');
      const second = await opened('Second shortfall.');

      const page = body(await list(admin.accessToken).expect(200)) as unknown as ListBody;
      expect(page.total).toBe(2);
      expect(page.items.map((i) => i.dispute.id)).toEqual([second.disputeId, first.disputeId]);
      expect(page.items[1]).toMatchObject({
        dispute: { id: first.disputeId, collectionId: first.collectionId, status: 'OPEN', reason: 'First shortfall.', openedByUserId: finance.userId },
        collection: {
          id: first.collectionId,
          jobId: first.jobId,
          orderId: first.orderId,
          driverId: first.driverProfileId,
          expectedAmount: ORDER_TOTAL,
          collectedAmount: COLLECTED,
          currency: 'ETB',
        },
      });
    });

    it('filters by status, collection, driver, job, order and the two time windows', async () => {
      const open = await opened();
      const closed = await opened();
      await resolve(finance.accessToken, closed.disputeId, { resolutionNote: 'Recovered.' }).expect(200);

      const ids = async (query: Record<string, string | number>) =>
        (body(await list(admin.accessToken, query).expect(200)) as unknown as ListBody).items.map((i) => i.dispute.id);

      expect(await ids({ status: 'OPEN' })).toEqual([open.disputeId]);
      expect(await ids({ status: 'RESOLVED' })).toEqual([closed.disputeId]);
      expect(await ids({ collectionId: open.collectionId })).toEqual([open.disputeId]);
      expect(await ids({ driverId: closed.driverProfileId })).toEqual([closed.disputeId]);
      expect(await ids({ jobId: open.jobId })).toEqual([open.disputeId]);
      expect(await ids({ orderId: closed.orderId })).toEqual([closed.disputeId]);

      const closedRow = (body(await detail(admin.accessToken, closed.disputeId).expect(200)) as unknown as DetailBody).dispute;
      expect(await ids({ resolvedFrom: closedRow.resolvedAt! })).toEqual([closed.disputeId]);
      expect(await ids({ resolvedTo: closedRow.resolvedAt! })).toEqual([]);

      // `closed` was opened after `open`, so its opening instant splits the two: [from, to).
      expect(await ids({ openedFrom: closedRow.openedAt })).toEqual([closed.disputeId]);
      expect(await ids({ openedTo: closedRow.openedAt })).toEqual([open.disputeId]);
    });

    it('pages deterministically without overlap', async () => {
      const a = await opened();
      const b = await opened();
      const c = await opened();

      const p1 = body(await list(admin.accessToken, { page: 1, size: 2 }).expect(200)) as unknown as ListBody;
      const p2 = body(await list(admin.accessToken, { page: 2, size: 2 }).expect(200)) as unknown as ListBody;
      const again = body(await list(admin.accessToken, { page: 1, size: 2 }).expect(200)) as unknown as ListBody;
      expect(p1).toMatchObject({ total: 3, page: 1, size: 2 });
      expect([...p1.items, ...p2.items].map((i) => i.dispute.id)).toEqual([c.disputeId, b.disputeId, a.disputeId]);
      expect(again.items.map((i) => i.dispute.id)).toEqual(p1.items.map((i) => i.dispute.id));
    });

    it('refuses malformed filters', async () => {
      const invalid: Array<Record<string, string | number>> = [
        { status: 'ESCALATED' },
        { collectionId: 'not-a-uuid' },
        { openedFrom: 'yesterday' },
        { size: 101 },
        { page: 0 },
        { reason: 'short' },
      ];
      for (const query of invalid) {
        const res = await list(admin.accessToken, query).expect(400);
        expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Detail
  // -------------------------------------------------------------------------------------------

  describe('detail', () => {
    it('returns the dispute with Module 08 full finance view of its collection', async () => {
      const s = await opened();

      const view = body(await detail(admin.accessToken, s.disputeId).expect(200)) as unknown as DetailBody;
      expect(view.dispute).toMatchObject({ id: s.disputeId, collectionId: s.collectionId, status: 'OPEN' });
      expect(view.collection).toMatchObject({
        id: s.collectionId,
        jobId: s.jobId,
        orderId: s.orderId,
        driverId: s.driverProfileId,
        expectedAmount: ORDER_TOTAL,
        collectedAmount: COLLECTED,
        collectionVariance: COLLECTED - ORDER_TOTAL,
        hasDiscrepancy: true,
        isOutstanding: true,
        remittance: null,
        reconciliation: null,
        corrections: [],
      });
      expect(view.collection.disputes.map((d) => d.id)).toEqual([s.disputeId]);

      // Module 08's own per-collection read agrees.
      const theirs = body(
        await request(ctx.server).get(`${M08}/${s.collectionId}/disputes`).set(...auth(admin.accessToken)).expect(200),
      ) as unknown as DisputeRow[];
      expect(theirs.map((d) => d.id)).toEqual([s.disputeId]);
    });

    it('carries nothing from Module 01 and no replay key', async () => {
      const s = await opened();
      const res = await detail(admin.accessToken, s.disputeId).expect(200);
      const raw = JSON.stringify(res.body);
      for (const forbidden of ['phone', 'email', 'passwordHash', 'faydaId', 'storageRef', 'idempotencyKey', 'accessToken']) {
        expect(raw).not.toContain(forbidden);
      }
    });

    it('answers 404 for an unknown dispute', async () => {
      const res = await detail(admin.accessToken, '00000000-0000-4000-8000-000000000000').expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Resolve
  // -------------------------------------------------------------------------------------------

  describe('resolve', () => {
    it('is Module 08 resolution: OPEN -> RESOLVED, its audit, the money untouched, then the admin audit', async () => {
      const s = await opened();
      const before = await ctx.prisma.codCollection.findUniqueOrThrow({ where: { id: s.collectionId } });

      const res = await resolve(finance.accessToken, s.disputeId, { resolutionNote: 'Driver handed over the balance.' }).expect(200);
      const result = body(res) as unknown as ResolutionBody;
      expect(result).toMatchObject({ collectionId: s.collectionId, previousStatus: 'OPEN', changed: true });
      expect(result.dispute).toMatchObject({
        id: s.disputeId,
        status: 'RESOLVED',
        resolvedByUserId: finance.userId,
        resolutionNote: 'Driver handed over the balance.',
      });
      expect(result.dispute.resolvedAt).not.toBeNull();

      const stored = await ctx.prisma.codDispute.findUniqueOrThrow({ where: { id: s.disputeId } });
      expect(stored.status).toBe('RESOLVED');
      expect(stored.resolvedByUserId).toBe(finance.userId);

      // Nothing about the money moved.
      const after = await ctx.prisma.codCollection.findUniqueOrThrow({ where: { id: s.collectionId } });
      expect(after).toEqual(before);
      expect(await ctx.prisma.codCorrection.count({ where: { collectionId: s.collectionId } })).toBe(0);
      expect(await ctx.prisma.outbox.count({ where: { eventType: { startsWith: 'admin.' } } })).toBe(0);

      const entries = await ctx.prisma.auditLog.findMany({
        where: { action: { in: ['DELIVERY_COD_DISPUTE_RESOLVED', 'ADMIN_COD_DISPUTE_RESOLVED'] } },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((e) => e.action)).toEqual(['DELIVERY_COD_DISPUTE_RESOLVED', 'ADMIN_COD_DISPUTE_RESOLVED']);
      const ours = entries[1];
      expect(ours.actorUserId).toBe(finance.userId);
      expect(ours.resourceType).toBe('CodDispute');
      expect(ours.resourceId).toBe(s.disputeId);
      expect(ours.context).toMatchObject({
        disputeId: s.disputeId,
        collectionId: s.collectionId,
        previousStatus: 'OPEN',
        status: 'RESOLVED',
        changed: true,
        resolutionNote: 'Driver handed over the balance.',
      });
      expect(ours.prevHash).toBe(entries[0].hash);
    });

    it('replays the same conclusion and refuses a different one, as Module 08 does', async () => {
      const s = await opened();
      await resolve(finance.accessToken, s.disputeId, { resolutionNote: 'Recovered.' }).expect(200);

      const replay = body(await resolve(finance.accessToken, s.disputeId, { resolutionNote: 'Recovered.' }).expect(200)) as unknown as ResolutionBody;
      expect(replay).toMatchObject({ previousStatus: 'RESOLVED', changed: false });
      expect(replay.dispute.resolutionNote).toBe('Recovered.');

      const different = await resolve(finance.accessToken, s.disputeId, { resolutionNote: 'Written off.' }).expect(409);
      expect(errorOf(different).code).toBe(ErrorCode.CONFLICT);

      const stored = await ctx.prisma.codDispute.findUniqueOrThrow({ where: { id: s.disputeId } });
      expect(stored.resolutionNote).toBe('Recovered.');
      // Two admin actions succeeded (one of them a replay); the refusal recorded nothing.
      expect(await adminAudits()).toBe(2);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_COD_DISPUTE_RESOLVED' } })).toBe(1);
    });

    it('resolves without a note, as Module 08 allows', async () => {
      const s = await opened();
      const result = body(await resolve(finance.accessToken, s.disputeId).expect(200)) as unknown as ResolutionBody;
      expect(result.dispute).toMatchObject({ status: 'RESOLVED', resolutionNote: null });
    });

    it('answers 404 for an unknown dispute and 400 for a body Module 08 does not take, with no admin audit', async () => {
      const s = await opened();
      const unknown = await resolve(finance.accessToken, '00000000-0000-4000-8000-000000000000', {}).expect(404);
      expect(errorOf(unknown).code).toBe(ErrorCode.NOT_FOUND);

      for (const payload of [
        { resolutionNote: 'x'.repeat(1001) },
        { resolutionNote: 'ok', actorUserId: admin.userId },
        { resolutionNote: 'ok', resolvedByUserId: admin.userId },
        { resolutionNote: 'ok', status: 'OPEN' },
        { resolutionNote: 'ok', outcome: 'WRITTEN_OFF' },
        { resolutionNote: 'ok', correctedAmount: ORDER_TOTAL },
      ]) {
        const res = await resolve(finance.accessToken, s.disputeId, payload).expect(400);
        expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      }

      const stored = await ctx.prisma.codDispute.findUniqueOrThrow({ where: { id: s.disputeId } });
      expect(stored.status).toBe('OPEN');
      expect(await adminAudits()).toBe(0);
    });

    /**
     * The database race, at the port so that the shared `AuditService`'s standalone Serializable
     * append (which the HTTP path adds after Module 08's own transactional one) is not what is
     * being measured. Module 08's compare-and-set decides: one call closes it, the other is handed
     * the winner's conclusion — or refused, when it brought a different one.
     */
    it('converges two concurrent resolutions on one conclusion', async () => {
      const same = await opened();
      const [a, b] = await Promise.all([
        port.resolveDispute({ actorUserId: finance.userId, disputeId: same.disputeId, resolutionNote: 'Recovered.' }),
        port.resolveDispute({ actorUserId: admin.userId, disputeId: same.disputeId, resolutionNote: 'Recovered.' }),
      ]);
      expect([a.changed, b.changed].sort()).toEqual([false, true]);
      expect(a.dispute.resolutionNote).toBe('Recovered.');
      expect(b.dispute.resolutionNote).toBe('Recovered.');
      expect(a.dispute.resolvedByUserId).toBe(b.dispute.resolvedByUserId);

      const differing = await opened();
      const outcomes = await Promise.allSettled([
        port.resolveDispute({ actorUserId: finance.userId, disputeId: differing.disputeId, resolutionNote: 'Recovered.' }),
        port.resolveDispute({ actorUserId: admin.userId, disputeId: differing.disputeId, resolutionNote: 'Written off.' }),
      ]);
      expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: ErrorCode.CONFLICT });
      const stored = await ctx.prisma.codDispute.findUniqueOrThrow({ where: { id: differing.disputeId } });
      expect(['Recovered.', 'Written off.']).toContain(stored.resolutionNote);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_COD_DISPUTE_RESOLVED' } })).toBe(2);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Boundaries, read-only reads, security
  // -------------------------------------------------------------------------------------------

  describe('boundaries and security', () => {
    it('Module 16 dispute code touches no Module 08 table, repository, entity or infrastructure', () => {
      const root = join(__dirname, '..', '..', 'src', 'modules', 'admin');
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
        }
      };
      walk(root);
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'prisma.codDispute',
          'prisma.codCollection',
          'prisma.codCorrection',
          'prisma.codRemittance',
          'prisma.codReconciliation',
          'COD_COLLECTION_REPOSITORY',
          'ICodCollectionRepository',
          'delivery/domain/entities/',
          'delivery/domain/repositories/',
          'delivery/infrastructure/',
          'delivery/application/commands/',
          'delivery/application/queries/',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('reading disputes appends no audit entry', async () => {
      const s = await opened();
      const before = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      await list(admin.accessToken).expect(200);
      await detail(admin.accessToken, s.disputeId).expect(200);
      const after = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      expect(after).toEqual(before);
    });

    it('applies Module 08 permission split: ADMIN may look and may not close', async () => {
      const s = await opened();
      await list(admin.accessToken).expect(200);
      await detail(admin.accessToken, s.disputeId).expect(200);
      const res = await resolve(admin.accessToken, s.disputeId, { resolutionNote: 'ok' }).expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
      expect((await ctx.prisma.codDispute.findUniqueOrThrow({ where: { id: s.disputeId } })).status).toBe('OPEN');
      expect(await adminAudits()).toBe(0);

      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
      await resolve(superAdmin.accessToken, s.disputeId, { resolutionNote: 'ok' }).expect(200);
    });

    it.each(['CUSTOMER', 'DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT'])('refuses %s on every route', async (role) => {
      const s = await opened();
      const caller = await createUserWithRole(ctx, role);
      for (const res of [
        await list(caller.accessToken),
        await detail(caller.accessToken, s.disputeId),
        await resolve(caller.accessToken, s.disputeId, { resolutionNote: 'ok' }),
      ]) {
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
      }
    });

    it('refuses an unauthenticated caller', async () => {
      const s = await opened();
      await request(ctx.server).get(DISPUTES).expect(401);
      await request(ctx.server).post(`${DISPUTES}/${s.disputeId}/resolve`).send({}).expect(401);
    });

    it('leaves Module 08 own routes answering exactly as before', async () => {
      const s = await opened();
      await request(ctx.server)
        .post(`${M08}/${s.collectionId}/disputes/${s.disputeId}/resolve`)
        .set(...auth(finance.accessToken))
        .send({ resolutionNote: 'Closed at the desk.' })
        .expect(200);
      expect(await adminAudits()).toBe(0);
      const view = body(await detail(admin.accessToken, s.disputeId).expect(200)) as unknown as DetailBody;
      expect(view.dispute).toMatchObject({ status: 'RESOLVED', resolutionNote: 'Closed at the desk.' });
    });
  });
});
