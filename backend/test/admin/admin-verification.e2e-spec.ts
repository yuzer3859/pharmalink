import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import {
  IDENTITY_PORT as DELIVERY_IDENTITY_PORT,
  IIdentityPort as IDeliveryIdentityPort,
} from '../../src/modules/delivery/application/ports/outbound/identity.port';
import { IdentityEventType } from '../../src/modules/identity/domain/events';
import { VerificationStatus } from '../../src/modules/identity/domain/enums';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../src/modules/identity/domain/repositories/verification.repository';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import {
  auth,
  body,
  createUserWithRole,
  errorOf,
  login,
  registerAndVerify,
  RegisteredUser,
  Tokens,
} from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const QUEUE = '/admin/verifications';

interface QueueItem {
  requestId: string;
  userId: string;
  organizationId: string | null;
  type: string;
  status: string;
  documentCount: number;
  submittedAt: string;
  reviewedAt: string | null;
  aging: { pendingSince: string | null; ageSeconds: number };
}

interface QueueBody {
  items: QueueItem[];
  total: number;
  page: number;
  size: number;
}

interface DetailBody extends QueueItem {
  documents: Array<{ kind: string; storageRef: string; expiresAt: string | null }>;
  hasFaydaId: boolean;
  reviewerId: string | null;
  rejectReason: string | null;
  expiresAt: string | null;
  applicant: { userId: string; primaryRole: string; accountStatus: string } | null;
}

interface DecisionBody {
  requestId: string;
  type: string;
  previousStatus: string;
  status: string;
  subjectUserId: string;
  organizationId: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
}

const DRIVER_DOCS = [
  { kind: 'DRIVING_LICENSE', storageRef: 'enc://verification/drv-licence-1' },
  { kind: 'VEHICLE_REGISTRATION', storageRef: 'enc://verification/drv-reg-1' },
];

const FAYDA_ID = '123456789012';

/**
 * Module 16 Work 02 against real PostgreSQL and the real HTTP stack.
 *
 * The claims that can only be made here: that a decision taken through the admin surface is the
 * decision Module 01 stores (its row, its event, its audit entry), that two administrators
 * deciding the same request at once resolve to exactly one authoritative outcome on the real
 * status column, that Module 08's driver eligibility sees the approval without any copy being
 * made, and that the guards — not a check somebody wrote — keep everyone but a verification
 * administrator out.
 */
describe('Admin verification management (e2e)', () => {
  let ctx: TestContext;
  let admin: RegisteredUser & Tokens;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — every request is opened through Module 01's own self-service route
  // -------------------------------------------------------------------------------------------

  /** A registered user who has submitted a `type` request through `POST /verification/documents`. */
  async function submitDocuments(
    type: 'DRIVER_DOCS' | 'PHARMACY_LICENSE' | 'DOCTOR_LICENSE',
    options: { user?: RegisteredUser & Tokens; organizationId?: string; documents?: typeof DRIVER_DOCS } = {},
  ): Promise<{ user: RegisteredUser & Tokens; requestId: string }> {
    const user =
      options.user ??
      (await (async () => {
        const registered = await registerAndVerify(ctx);
        return { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
      })());
    const res = await request(ctx.server)
      .post('/verification/documents')
      .set(...auth(user.accessToken))
      .send({
        type,
        organizationId: options.organizationId,
        documents: options.documents ?? DRIVER_DOCS,
      })
      .expect(202);
    return { user, requestId: body(res).requestId as string };
  }

  async function submitFayda(): Promise<{ user: RegisteredUser & Tokens; requestId: string }> {
    const registered = await registerAndVerify(ctx);
    const user = { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
    const res = await request(ctx.server)
      .post('/verification/fayda')
      .set(...auth(user.accessToken))
      .send({ faydaId: FAYDA_ID, consentGranted: true })
      .expect(202);
    return { user, requestId: body(res).requestId as string };
  }

  /** Test-only clock control: backdates a submission so aging and ordering are observable. */
  async function backdate(requestId: string, submittedAt: Date): Promise<void> {
    await ctx.prisma.verificationRequest.update({ where: { id: requestId }, data: { submittedAt } });
  }

  const list = (token: string, query: Record<string, string | number> = {}) =>
    request(ctx.server).get(QUEUE).set(...auth(token)).query(query);
  const detail = (token: string, id: string) =>
    request(ctx.server).get(`${QUEUE}/${id}`).set(...auth(token));
  const approve = (token: string, id: string, payload: Record<string, unknown> = {}) =>
    request(ctx.server).post(`${QUEUE}/${id}/approve`).set(...auth(token)).send(payload);
  const reject = (token: string, id: string, payload: Record<string, unknown> = {}) =>
    request(ctx.server).post(`${QUEUE}/${id}/reject`).set(...auth(token)).send(payload);

  // -------------------------------------------------------------------------------------------
  // 1. Queue
  // -------------------------------------------------------------------------------------------

  describe('queue', () => {
    it('lists a pending request with its aging', async () => {
      const { requestId, user } = await submitDocuments('DRIVER_DOCS');

      const res = await list(admin.accessToken).expect(200);
      const page = body(res) as unknown as QueueBody;
      expect(page.total).toBe(1);
      const [item] = page.items;
      expect(item).toMatchObject({
        requestId,
        userId: user.userId,
        type: 'DRIVER_DOCS',
        status: 'PENDING',
        documentCount: 2,
        reviewedAt: null,
      });
      expect(item.aging.pendingSince).toBe(item.submittedAt);
      expect(item.aging.ageSeconds).toBeGreaterThanOrEqual(0);
      expect(item.aging.ageSeconds).toBeLessThan(60);
    });

    it('omits decided requests by default and lists them under their own status', async () => {
      const pending = await submitDocuments('DRIVER_DOCS');
      const decided = await submitDocuments('DRIVER_DOCS');
      await approve(admin.accessToken, decided.requestId).expect(200);

      const defaults = body(await list(admin.accessToken).expect(200)) as unknown as QueueBody;
      expect(defaults.items.map((i) => i.requestId)).toEqual([pending.requestId]);

      const approved = body(
        await list(admin.accessToken, { status: 'APPROVED' }).expect(200),
      ) as unknown as QueueBody;
      expect(approved.items.map((i) => i.requestId)).toEqual([decided.requestId]);
      expect(approved.items[0].aging.pendingSince).toBeNull();
      expect(approved.items[0].reviewedAt).not.toBeNull();
    });

    it('filters by verification type', async () => {
      const driver = await submitDocuments('DRIVER_DOCS');
      const pharmacy = await submitDocuments('PHARMACY_LICENSE', {
        documents: [{ kind: 'BUSINESS_LICENSE', storageRef: 'enc://verification/biz-1' }],
      });

      const drivers = body(
        await list(admin.accessToken, { type: 'DRIVER_DOCS' }).expect(200),
      ) as unknown as QueueBody;
      expect(drivers.items.map((i) => i.requestId)).toEqual([driver.requestId]);

      const pharmacies = body(
        await list(admin.accessToken, { type: 'PHARMACY_LICENSE' }).expect(200),
      ) as unknown as QueueBody;
      expect(pharmacies.items.map((i) => i.requestId)).toEqual([pharmacy.requestId]);
    });

    it('filters by applicant and by submission window', async () => {
      const a = await submitDocuments('DRIVER_DOCS');
      const b = await submitDocuments('DRIVER_DOCS');
      await backdate(a.requestId, new Date('2026-09-01T08:00:00.000Z'));
      await backdate(b.requestId, new Date('2026-09-10T08:00:00.000Z'));

      const byUser = body(
        await list(admin.accessToken, { userId: b.user.userId }).expect(200),
      ) as unknown as QueueBody;
      expect(byUser.items.map((i) => i.requestId)).toEqual([b.requestId]);

      const window = body(
        await list(admin.accessToken, {
          submittedFrom: '2026-09-01T00:00:00.000Z',
          submittedTo: '2026-09-02T00:00:00.000Z',
        }).expect(200),
      ) as unknown as QueueBody;
      expect(window.items.map((i) => i.requestId)).toEqual([a.requestId]);
    });

    it('pages without overlap and reports the total', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const { requestId } = await submitDocuments('DRIVER_DOCS');
        await backdate(requestId, new Date(Date.UTC(2026, 8, 1 + i)));
        ids.push(requestId);
      }

      const first = body(
        await list(admin.accessToken, { page: 1, size: 2 }).expect(200),
      ) as unknown as QueueBody;
      const second = body(
        await list(admin.accessToken, { page: 2, size: 2 }).expect(200),
      ) as unknown as QueueBody;

      expect(first).toMatchObject({ total: 3, page: 1, size: 2 });
      expect(second).toMatchObject({ total: 3, page: 2, size: 2 });
      expect(first.items).toHaveLength(2);
      expect(second.items).toHaveLength(1);
      expect([...first.items, ...second.items].map((i) => i.requestId)).toEqual(ids);
    });

    it('orders oldest submission first and breaks ties deterministically', async () => {
      const newer = await submitDocuments('DRIVER_DOCS');
      const older = await submitDocuments('DRIVER_DOCS');
      const tieA = await submitDocuments('DRIVER_DOCS');
      const tieB = await submitDocuments('DRIVER_DOCS');
      await backdate(newer.requestId, new Date('2026-09-15T00:00:00.000Z'));
      await backdate(older.requestId, new Date('2026-09-01T00:00:00.000Z'));
      const tie = new Date('2026-09-10T00:00:00.000Z');
      await backdate(tieA.requestId, tie);
      await backdate(tieB.requestId, tie);

      const expectedTie = [tieA.requestId, tieB.requestId].sort();
      const expected = [older.requestId, ...expectedTie, newer.requestId];

      const once = body(await list(admin.accessToken).expect(200)) as unknown as QueueBody;
      const twice = body(await list(admin.accessToken).expect(200)) as unknown as QueueBody;
      expect(once.items.map((i) => i.requestId)).toEqual(expected);
      expect(twice.items.map((i) => i.requestId)).toEqual(expected);
    });

    it('derives age from the stored submission time', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');
      const submittedAt = new Date(Date.now() - 3 * 3600 * 1000);
      await backdate(requestId, submittedAt);

      const page = body(await list(admin.accessToken).expect(200)) as unknown as QueueBody;
      const [item] = page.items;
      expect(item.aging.pendingSince).toBe(submittedAt.toISOString());
      expect(item.aging.ageSeconds).toBeGreaterThanOrEqual(3 * 3600);
      expect(item.aging.ageSeconds).toBeLessThan(3 * 3600 + 60);
    });

    it('refuses a filter over a value Module 01 does not define', async () => {
      const res = await list(admin.accessToken, { status: 'UNDER_REVIEW' }).expect(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);

      const tooBig = await list(admin.accessToken, { size: 101 }).expect(400);
      expect(errorOf(tooBig).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('never carries the Fayda identifier or a document reference', async () => {
      await submitFayda();
      await submitDocuments('DRIVER_DOCS');

      const res = await list(admin.accessToken).expect(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(FAYDA_ID);
      expect(raw).not.toContain('storageRef');
      expect(raw).not.toContain('faydaId');
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Detail
  // -------------------------------------------------------------------------------------------

  describe('detail', () => {
    it('shows an authorized administrator the document references and the applicant', async () => {
      const { requestId, user } = await submitDocuments('DRIVER_DOCS');

      const view = body(await detail(admin.accessToken, requestId).expect(200)) as unknown as DetailBody;
      expect(view.requestId).toBe(requestId);
      expect(view.documents).toEqual([
        { kind: 'DRIVING_LICENSE', storageRef: 'enc://verification/drv-licence-1', expiresAt: null },
        { kind: 'VEHICLE_REGISTRATION', storageRef: 'enc://verification/drv-reg-1', expiresAt: null },
      ]);
      expect(view.hasFaydaId).toBe(false);
      expect(view.applicant).toEqual({
        userId: user.userId,
        primaryRole: 'CUSTOMER',
        accountStatus: 'ACTIVE',
      });
      expect(view.aging.pendingSince).toBe(view.submittedAt);
    });

    it('reports that a Fayda check is attached without ever exposing the number', async () => {
      const { requestId } = await submitFayda();

      const res = await detail(admin.accessToken, requestId).expect(200);
      const view = body(res) as unknown as DetailBody;
      expect(view.hasFaydaId).toBe(true);
      expect(view.type).toBe('FAYDA');
      expect(JSON.stringify(res.body)).not.toContain(FAYDA_ID);
      expect(Object.keys(view)).not.toContain('faydaIdEncrypted');
    });

    it('answers 404 for an unknown request', async () => {
      const res = await detail(admin.accessToken, '00000000-0000-4000-8000-000000000000').expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('refuses an authenticated user without the queue permission', async () => {
      const { requestId, user } = await submitDocuments('DRIVER_DOCS');
      // The applicant themselves — authenticated, and the subject of the request.
      const res = await detail(user.accessToken, requestId).expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Approval
  // -------------------------------------------------------------------------------------------

  describe('approval', () => {
    it('is stored by Module 01 with the authenticated administrator as reviewer', async () => {
      const { requestId, user } = await submitDocuments('DRIVER_DOCS');

      const res = await approve(admin.accessToken, requestId, {
        expiresAt: '2027-12-31T00:00:00.000Z',
        reason: 'Licence verified against the transport authority registry',
      }).expect(200);
      const decision = body(res) as unknown as DecisionBody;
      expect(decision).toMatchObject({
        requestId,
        type: 'DRIVER_DOCS',
        previousStatus: 'PENDING',
        status: 'APPROVED',
        subjectUserId: user.userId,
        expiresAt: '2027-12-31T00:00:00.000Z',
      });
      expect(decision.decidedAt).not.toBeNull();

      const stored = await ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(stored.status).toBe('APPROVED');
      expect(stored.reviewerId).toBe(admin.userId);
      expect(stored.reviewedAt).not.toBeNull();
      expect(stored.expiresAt?.toISOString()).toBe('2027-12-31T00:00:00.000Z');
    });

    it('rejects a body that tries to name the reviewer', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');
      const other = await createUserWithRole(ctx, 'ADMIN');

      for (const field of ['reviewerId', 'actorUserId', 'userId']) {
        const res = await approve(admin.accessToken, requestId, { [field]: other.userId }).expect(400);
        expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      }

      const stored = await ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(stored.status).toBe('PENDING');
      expect(stored.reviewerId).toBeNull();
    });

    it('writes the admin audit entry alongside Module 01 own, both hash-chained', async () => {
      const { requestId, user } = await submitDocuments('DRIVER_DOCS');
      await approve(admin.accessToken, requestId, { reason: 'ok' }).expect(200);

      const entries = await ctx.prisma.auditLog.findMany({
        where: { resourceId: requestId },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((e) => e.action)).toEqual([
        'identity.verification.documents_attached',
        'identity.verification.approved',
        'ADMIN_VERIFICATION_APPROVED',
      ]);

      const adminEntry = entries[2];
      expect(adminEntry.actorUserId).toBe(admin.userId);
      expect(adminEntry.resourceType).toBe('verification_request');
      expect(adminEntry.context).toMatchObject({
        verificationType: 'DRIVER_DOCS',
        previousStatus: 'PENDING',
        status: 'APPROVED',
        subjectUserId: user.userId,
        reason: 'ok',
      });
      expect(JSON.stringify(adminEntry.context)).not.toContain('storageRef');
      // The chain links: this entry binds the hash of the one before it.
      expect(adminEntry.prevHash).toBe(entries[1].hash);
    });

    it('cannot be repeated once decided', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');
      await approve(admin.accessToken, requestId).expect(200);

      const again = await approve(admin.accessToken, requestId).expect(422);
      expect(errorOf(again).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);
      const flipped = await reject(admin.accessToken, requestId, { reason: 'changed my mind' }).expect(422);
      expect(errorOf(flipped).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);

      expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_VERIFICATION_APPROVED' } })).toBe(1);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_VERIFICATION_REJECTED' } })).toBe(0);
    });

    it('surfaces Module 01 separation-of-duties rule: a reviewer cannot decide their own request', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS', { user: admin });
      const res = await approve(admin.accessToken, requestId).expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);

      const stored = await ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(stored.status).toBe('PENDING');
    });

    it('resolves concurrent approve and reject to exactly one authoritative decision', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');
      const second = await createUserWithRole(ctx, 'ADMIN');

      const [a, b] = await Promise.all([
        approve(admin.accessToken, requestId),
        reject(second.accessToken, requestId, { reason: 'Documents unreadable' }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 422]);
      const loser = a.status === 422 ? a : b;
      expect(errorOf(loser).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);

      const stored = await ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id: requestId } });
      const winner = a.status === 200 ? 'APPROVED' : 'REJECTED';
      expect(stored.status).toBe(winner);
      expect(stored.reviewerId).toBe(a.status === 200 ? admin.userId : second.userId);

      // One Module 01 decision event, one admin audit entry — never both.
      const events = await ctx.prisma.outbox.findMany({
        where: {
          eventType: { in: [IdentityEventType.ProviderApproved, IdentityEventType.ProviderRejected] },
        },
      });
      expect(events).toHaveLength(1);
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: { in: ['ADMIN_VERIFICATION_APPROVED', 'ADMIN_VERIFICATION_REJECTED'] } },
        }),
      ).toBe(1);
    });

    /**
     * The HTTP race above may or may not interleave at the database. This one does by
     * construction: both reviewers hold a PENDING copy, both pass the aggregate's own check, and
     * the second write must lose on the status column itself.
     */
    it('loses the lost-update race on the status column, not on the in-memory copy', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');
      const second = await createUserWithRole(ctx, 'ADMIN');
      const repo = ctx.app.get<IVerificationRepository>(VERIFICATION_REPOSITORY);

      const copyA = (await repo.findById(requestId))!;
      const copyB = (await repo.findById(requestId))!;
      copyA.approve(admin.userId, null);
      copyB.reject(second.userId, 'Documents unreadable');

      await repo.save(copyA, { status: VerificationStatus.PENDING });
      await expect(repo.save(copyB, { status: VerificationStatus.PENDING })).rejects.toMatchObject({
        code: ErrorCode.BUSINESS_RULE_VIOLATION,
        details: { status: 'APPROVED' },
      });

      const stored = await ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(stored.status).toBe('APPROVED');
      expect(stored.reviewerId).toBe(admin.userId);
      expect(stored.rejectReason).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Rejection
  // -------------------------------------------------------------------------------------------

  describe('rejection', () => {
    it('is stored by Module 01 with the reason and the authenticated reviewer', async () => {
      const { requestId, user } = await submitDocuments('DRIVER_DOCS');

      const res = await reject(admin.accessToken, requestId, {
        reason: 'Vehicle registration has expired',
      }).expect(200);
      expect(body(res)).toMatchObject({
        requestId,
        previousStatus: 'PENDING',
        status: 'REJECTED',
        subjectUserId: user.userId,
      });

      const stored = await ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(stored.status).toBe('REJECTED');
      expect(stored.reviewerId).toBe(admin.userId);
      expect(stored.rejectReason).toBe('Vehicle registration has expired');

      // The applicant sees Module 01's own record of it.
      const status = await request(ctx.server)
        .get('/verification/status')
        .set(...auth(user.accessToken))
        .expect(200);
      const mine = (body(status) as unknown as Array<{ requestId: string; rejectReason: string }>).find(
        (i) => i.requestId === requestId,
      );
      expect(mine?.rejectReason).toBe('Vehicle registration has expired');
    });

    it('requires a meaningful reason', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');

      for (const payload of [{}, { reason: '' }, { reason: 'no' }, { reason: 'x'.repeat(501) }]) {
        const res = await reject(admin.accessToken, requestId, payload).expect(400);
        expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      }
      // Passes the length check, fails Module 01's own "not blank" rule.
      const blank = await reject(admin.accessToken, requestId, { reason: '    ' }).expect(400);
      expect(errorOf(blank).code).toBe(ErrorCode.VALIDATION_ERROR);

      const stored = await ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(stored.status).toBe('PENDING');
    });

    it('writes the admin audit entry with the reason', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');
      await reject(admin.accessToken, requestId, { reason: 'Vehicle registration has expired' }).expect(200);

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'ADMIN_VERIFICATION_REJECTED', resourceId: requestId },
      });
      expect(entry.actorUserId).toBe(admin.userId);
      expect(entry.context).toMatchObject({
        previousStatus: 'PENDING',
        status: 'REJECTED',
        reason: 'Vehicle registration has expired',
      });
    });

    it('cannot be repeated once decided', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');
      await reject(admin.accessToken, requestId, { reason: 'Vehicle registration has expired' }).expect(200);

      const again = await reject(admin.accessToken, requestId, { reason: 'still expired' }).expect(422);
      expect(errorOf(again).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);
      const flipped = await approve(admin.accessToken, requestId).expect(422);
      expect(errorOf(flipped).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Ownership and boundaries
  // -------------------------------------------------------------------------------------------

  describe('ownership and boundaries', () => {
    it('Module 16 source touches no Module 01 table or repository', () => {
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
          'prisma.verificationRequest',
          'prisma.user',
          'prisma.organization',
          'VERIFICATION_REPOSITORY',
          'IVerificationRepository',
          'USER_REPOSITORY',
          'IUserRepository',
          'domain/entities/verification-request',
          'infrastructure/persistence/prisma-verification',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({
            file,
            forbidden,
            found: false,
          });
        }
      }
    });

    it('emits Module 01 own ProviderApproved contract, and no admin event', async () => {
      const { requestId, user } = await submitDocuments('DRIVER_DOCS');
      await approve(admin.accessToken, requestId).expect(200);

      const events = await ctx.prisma.outbox.findMany({
        where: { eventType: IdentityEventType.ProviderApproved },
      });
      expect(events).toHaveLength(1);
      const envelope = events[0].payload as unknown as {
        type: string;
        aggregateType: string;
        aggregateId: string;
        payload: Record<string, unknown>;
      };
      expect(envelope.aggregateType).toBe('User');
      expect(envelope.aggregateId).toBe(user.userId);
      expect(Object.keys(envelope.payload).sort()).toEqual(
        ['organizationId', 'reviewerId', 'userId', 'verificationRequestId', 'verificationType'].sort(),
      );
      expect(envelope.payload).toMatchObject({
        userId: user.userId,
        verificationRequestId: requestId,
        verificationType: 'DRIVER_DOCS',
        reviewerId: admin.userId,
      });

      const adminEvents = await ctx.prisma.outbox.count({
        where: { eventType: { startsWith: 'admin.' } },
      });
      expect(adminEvents).toBe(0);
    });

    it('lifts a PENDING_APPROVAL pharmacy owner through Module 01, and activates nothing in Module 04', async () => {
      const { requestId, user } = await submitDocuments('PHARMACY_LICENSE', {
        documents: [{ kind: 'BUSINESS_LICENSE', storageRef: 'enc://verification/biz-1' }],
      });
      // Module 01's own state for a provider awaiting approval (test seeding, not a Module 16 write).
      await ctx.prisma.user.update({
        where: { id: user.userId },
        data: { primaryRole: 'PHARMACY_OWNER', status: 'PENDING_APPROVAL' },
      });

      await approve(admin.accessToken, requestId).expect(200);

      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(stored.status).toBe('ACTIVE');

      // Module 04 stays on its explicit `POST /pharmacy/activate`: no pharmacy row was created or
      // changed by an approval, and nothing in this module knows the table exists.
      expect(await ctx.prisma.pharmacy.count()).toBe(0);
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'PHARMACY_ACTIVATED' } }),
      ).toBe(0);
    });

    it('makes a driver eligible in Module 08 through the live read, not a copy', async () => {
      const { requestId, user } = await submitDocuments('DRIVER_DOCS');
      await ctx.prisma.user.update({ where: { id: user.userId }, data: { primaryRole: 'DRIVER' } });
      const identity = ctx.app.get<IDeliveryIdentityPort>(DELIVERY_IDENTITY_PORT);

      const before = await identity.getDriverIdentity(user.userId);
      expect(before).toMatchObject({ isEligible: false, reason: 'DOCUMENTS_NOT_APPROVED' });

      await approve(admin.accessToken, requestId, { expiresAt: '2027-12-31T00:00:00.000Z' }).expect(200);

      const after = await identity.getDriverIdentity(user.userId);
      expect(after).toMatchObject({ isEligible: true, reason: null });
      expect(after.documentsExpireAt?.toISOString()).toBe('2027-12-31T00:00:00.000Z');

      // Nothing in Module 16's tables holds the answer.
      const adminTables = ['platform_configs', 'feature_flags'];
      for (const table of adminTables) {
        const rows = await ctx.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT COUNT(*)::bigint AS count FROM "${table}"`,
        );
        expect(Number(rows[0].count)).toBe(0);
      }
    });

    it('leaves Module 01 own admin routes working exactly as before', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');

      const queue = await request(ctx.server)
        .get('/admin/verification/queue')
        .set(...auth(admin.accessToken))
        .expect(200);
      expect((body(queue).items as Array<{ requestId: string }>).map((i) => i.requestId)).toContain(requestId);

      await request(ctx.server)
        .post(`/admin/verification/${requestId}/approve`)
        .set(...auth(admin.accessToken))
        .send({})
        .expect(204);

      // And the admin surface sees the decision Module 01 took.
      const view = body(await detail(admin.accessToken, requestId).expect(200)) as unknown as DetailBody;
      expect(view.status).toBe('APPROVED');
      expect(view.reviewerId).toBe(admin.userId);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Security
  // -------------------------------------------------------------------------------------------

  describe('security', () => {
    it.each(['CUSTOMER', 'DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER'])(
      'refuses %s on every route',
      async (role) => {
        const { requestId } = await submitDocuments('DRIVER_DOCS');
        const caller = await createUserWithRole(ctx, role);

        for (const res of [
          await list(caller.accessToken),
          await detail(caller.accessToken, requestId),
          await approve(caller.accessToken, requestId),
          await reject(caller.accessToken, requestId, { reason: 'not allowed' }),
        ]) {
          expect(res.status).toBe(403);
          expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
        }

        const stored = await ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id: requestId } });
        expect(stored.status).toBe('PENDING');
      },
    );

    it('refuses an unauthenticated caller', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');
      await request(ctx.server).get(QUEUE).expect(401);
      await request(ctx.server).post(`${QUEUE}/${requestId}/approve`).send({}).expect(401);
    });

    it('admits ADMIN and SUPER_ADMIN, the holders of the existing permissions', async () => {
      const { requestId } = await submitDocuments('DRIVER_DOCS');
      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');

      await list(admin.accessToken).expect(200);
      await list(superAdmin.accessToken).expect(200);
      await detail(superAdmin.accessToken, requestId).expect(200);
      await approve(superAdmin.accessToken, requestId).expect(200);
    });
  });
});
