import { ApprovalEntityType, ConfigValueType } from '@prisma/client';
import request from 'supertest';
import { MakerCheckerGate } from '../../src/modules/admin/application/maker-checker/maker-checker-gate.service';
import { AdminEventType } from '../../src/modules/admin/domain/events';
import {
  MakerCheckerActionRegistry,
  MakerCheckerExecutionContext,
} from '../../src/modules/admin/domain/maker-checker/maker-checker-action';
import { ConfigOverrideLoader } from '../../src/modules/admin/infrastructure/config/config-override.loader';
import { ApprovalExpiryJob } from '../../src/modules/admin/infrastructure/jobs/approval-expiry.job';
import { ApiException } from '../../src/shared/errors/api-exception';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Work 82: maker-checker over the real HTTP stack, database, audit chain and outbox.
 *
 * No production action is registered until Works 83 and 84, so this spec registers one test
 * action through the public registry. Its executor stands in for an owning module: it keeps its
 * own idempotency by key (as BRULE-25 requires of every money command) and can be told to refuse.
 * Turning the action on writes the `approvals.makerCheckerActions` override row directly, because
 * the governed list only accepts registered production types (the HTTP refusal is tested below).
 */
const ACTION = 'E2E_TEST_PAYOUT';
const PERMISSION = 'finance:settlement:any';
const APPROVALS = '/admin/approvals';

interface ApprovalBody {
  id: string;
  status: string;
  actionType: string;
  entityId: string;
  summary: string;
  canDecide: boolean;
  isOwnRequest: boolean;
  decidedByUserId: string | null;
  decisionNote: string | null;
  executedAt: string | null;
  executionResult: Record<string, unknown> | null;
  executionError: { code: string; message: string } | null;
}

describe('Maker-checker (e2e)', () => {
  let ctx: TestContext;
  let gate: MakerCheckerGate;
  let loader: ConfigOverrideLoader;
  let maker: RegisteredUser & Tokens;
  let checker: RegisteredUser & Tokens;
  let admin: RegisteredUser & Tokens;
  let customer: RegisteredUser & Tokens;

  /** The stand-in owning module: one effect per idempotency key. */
  const effects = new Map<string, Record<string, unknown>>();
  const calls: MakerCheckerExecutionContext[] = [];
  let refuseNext: ApiException | null = null;

  beforeAll(async () => {
    ctx = await createTestApp();
    gate = ctx.app.get(MakerCheckerGate);
    loader = ctx.app.get(ConfigOverrideLoader);
    ctx.app.get(MakerCheckerActionRegistry).register({
      type: ACTION,
      entityType: ApprovalEntityType.PAYOUT,
      requiredPermission: PERMISSION,
      describe: (payload) => {
        if (typeof payload.settlementId !== 'string') {
          throw new ApiException(ErrorCode.VALIDATION_ERROR, 'settlementId is required.');
        }
        return { entityId: payload.settlementId, summary: `Pay settlement ${payload.settlementId}` };
      },
      execute: async (payload, context) => {
        calls.push(context);
        if (refuseNext) {
          const err = refuseNext;
          refuseNext = null;
          throw err;
        }
        const existing = effects.get(context.idempotencyKey);
        if (existing) return existing;
        const effect = { paidSettlementId: payload.settlementId, by: context.actorUserId };
        effects.set(context.idempotencyKey, effect);
        return effect;
      },
    });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    effects.clear();
    calls.length = 0;
    refuseNext = null;
    maker = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    checker = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    admin = await createUserWithRole(ctx, 'ADMIN');
    customer = await createUserWithRole(ctx, 'CUSTOMER');
    await ctx.prisma.platformConfig.create({
      data: {
        namespace: 'approvals',
        key: 'makerCheckerActions',
        value: [ACTION],
        valueType: ConfigValueType.JSON,
        version: 1,
        isActive: true,
        updatedBy: maker.userId,
      },
    });
    await loader.refresh();
  });

  async function request_(settlementId = 'set-1', key = `k-${settlementId}`) {
    const result = await gate.submit({
      actionType: ACTION,
      payload: { settlementId },
      makerUserId: maker.userId,
      makerPermissions: [PERMISSION],
      idempotencyKey: key,
      reason: 'Month-end payout',
    });
    if (result.outcome !== 'PENDING_APPROVAL') throw new Error('expected a pending request');
    return result.approval;
  }

  const get = (token: string, path: string) => request(ctx.server).get(path).set(...auth(token));
  const decide = (token: string, id: string, payload: Record<string, unknown>) =>
    request(ctx.server).post(`${APPROVALS}/${id}/decide`).set(...auth(token)).send(payload);

  it('refuses a caller without approval:read:any (403)', async () => {
    const approval = await request_();
    expect(errorOf(await get(customer.accessToken, APPROVALS).expect(403)).code).toBe('FORBIDDEN');
    await get(customer.accessToken, `${APPROVALS}/${approval.id}`).expect(403);
    await decide(customer.accessToken, approval.id, { decision: 'APPROVE' }).expect(403);
  });

  it('lists a pending request with the right decision rights for each reader', async () => {
    const approval = await request_();
    const forChecker = body(await get(checker.accessToken, `${APPROVALS}?status=PENDING`).expect(200));
    expect(forChecker.total).toBe(1);
    expect((forChecker.items as ApprovalBody[])[0]).toMatchObject({
      id: approval.id,
      status: 'PENDING',
      actionType: ACTION,
      entityId: 'set-1',
      summary: 'Pay settlement set-1',
      canDecide: true,
      isOwnRequest: false,
    });

    const forMaker = body(await get(maker.accessToken, `${APPROVALS}/${approval.id}`).expect(200));
    expect(forMaker).toMatchObject({ canDecide: false, isOwnRequest: true });
    const mine = body(await get(maker.accessToken, `${APPROVALS}?mine=true`).expect(200));
    expect(mine.total).toBe(1);
    expect(body(await get(checker.accessToken, `${APPROVALS}?mine=true`).expect(200)).total).toBe(0);

    // ADMIN sees the queue but holds no finance:settlement:any.
    expect(body(await get(admin.accessToken, `${APPROVALS}/${approval.id}`).expect(200)).canDecide).toBe(false);

    const actions = body(await get(checker.accessToken, `${APPROVALS}/actions`).expect(200));
    expect(actions.items).toEqual(
      expect.arrayContaining([
        { type: ACTION, entityType: 'PAYOUT', requiredPermission: PERMISSION, requiresApproval: true },
      ]),
    );
  });

  it('refuses the maker (403 MAKER_CHECKER_SELF_APPROVAL) and a checker without the permission (403)', async () => {
    const approval = await request_();
    const self = await decide(maker.accessToken, approval.id, { decision: 'APPROVE' }).expect(403);
    expect(errorOf(self).code).toBe(ErrorCode.MAKER_CHECKER_SELF_APPROVAL);
    const unentitled = await decide(admin.accessToken, approval.id, { decision: 'APPROVE' }).expect(403);
    expect(errorOf(unentitled).code).toBe(ErrorCode.FORBIDDEN);
    expect(calls).toHaveLength(0);
    expect(body(await get(checker.accessToken, `${APPROVALS}/${approval.id}`).expect(200)).status).toBe('PENDING');
  });

  it('validates the decision (400)', async () => {
    const approval = await request_();
    for (const payload of [{}, { decision: 'MAYBE' }, { decision: 'APPROVE', checkerUserId: maker.userId }]) {
      expect(errorOf(await decide(checker.accessToken, approval.id, payload).expect(400)).code).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
    }
    const noReason = await decide(checker.accessToken, approval.id, { decision: 'REJECT' }).expect(400);
    expect(errorOf(noReason).code).toBe(ErrorCode.VALIDATION_ERROR);
    await decide(checker.accessToken, 'not-a-uuid', { decision: 'APPROVE' }).expect(400);
    await get(checker.accessToken, `${APPROVALS}?status=SOMETIMES`).expect(400);
    const missing = await decide(checker.accessToken, '00000000-0000-4000-8000-000000000000', {
      decision: 'APPROVE',
    }).expect(404);
    expect(errorOf(missing).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('approves, executes once with approval:<id>, and answers a repeat with the stored outcome', async () => {
    const approval = await request_();
    const first = body(
      await decide(checker.accessToken, approval.id, { decision: 'APPROVE', reason: 'Checked the statement' }).expect(200),
    ) as unknown as ApprovalBody;
    expect(first).toMatchObject({
      status: 'APPROVED',
      decidedByUserId: checker.userId,
      decisionNote: 'Checked the statement',
      executionResult: { paidSettlementId: 'set-1', by: checker.userId },
      canDecide: false,
    });
    expect(first.executedAt).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      approvalId: approval.id,
      idempotencyKey: `approval:${approval.id}`,
      makerUserId: maker.userId,
      actorUserId: checker.userId,
    });

    const again = body(await decide(checker.accessToken, approval.id, { decision: 'APPROVE' }).expect(200));
    expect(again).toEqual(first);
    expect(calls).toHaveLength(1);

    const flip = await decide(checker.accessToken, approval.id, { decision: 'REJECT', reason: 'Too late' }).expect(409);
    expect(errorOf(flip).code).toBe(ErrorCode.APPROVAL_ALREADY_DECIDED);

    // Both parties in the hash-chained audit, and the decision on the outbox.
    const audit = await ctx.prisma.auditLog.findMany({
      where: { resourceType: 'ApprovalRequest', resourceId: approval.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => [a.action, a.actorUserId])).toEqual([
      ['APPROVAL_REQUESTED', maker.userId],
      ['APPROVAL_APPROVED', checker.userId],
      ['APPROVAL_EXECUTED', checker.userId],
    ]);
    expect(audit[1].context).toMatchObject({ requestedBy: maker.userId, decidedBy: checker.userId });
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateId: approval.id, eventType: { in: [AdminEventType.ApprovalRequested, AdminEventType.ApprovalDecided] } },
      }),
    ).toBe(2);
  });

  it('rejects with a reason and never runs the action', async () => {
    const approval = await request_();
    const rejected = body(
      await decide(checker.accessToken, approval.id, { decision: 'REJECT', reason: 'Wrong account' }).expect(200),
    );
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionNote: 'Wrong account', executedAt: null });
    expect(calls).toHaveLength(0);
    const approve = await decide(checker.accessToken, approval.id, { decision: 'APPROVE' }).expect(409);
    expect(errorOf(approve).code).toBe(ErrorCode.APPROVAL_ALREADY_DECIDED);
  });

  it('is idempotent for the maker and allows one open request per target', async () => {
    const approval = await request_('set-1', 'same-key');
    expect((await request_('set-1', 'same-key')).id).toBe(approval.id);
    await expect(
      gate.submit({
        actionType: ACTION,
        payload: { settlementId: 'set-2' },
        makerUserId: maker.userId,
        makerPermissions: [PERMISSION],
        idempotencyKey: 'same-key',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_CONFLICT });
    await expect(
      gate.submit({
        actionType: ACTION,
        payload: { settlementId: 'set-1' },
        makerUserId: checker.userId,
        makerPermissions: [PERMISSION],
        idempotencyKey: 'another',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT, details: { approvalId: approval.id } });
    expect(await ctx.prisma.approvalRequest.count()).toBe(1);
  });

  it('expires: a past-expiry request reads EXPIRED, cannot be decided, and the sweeper persists it', async () => {
    const decidedLate = await request_('set-1');
    const swept = await request_('set-2');
    await ctx.prisma.approvalRequest.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });

    expect(body(await get(checker.accessToken, `${APPROVALS}/${decidedLate.id}`).expect(200))).toMatchObject({
      status: 'EXPIRED',
      canDecide: false,
    });
    expect(body(await get(checker.accessToken, `${APPROVALS}?status=PENDING`).expect(200)).total).toBe(0);
    expect(body(await get(checker.accessToken, `${APPROVALS}?status=EXPIRED`).expect(200)).total).toBe(2);

    const late = await decide(checker.accessToken, decidedLate.id, { decision: 'APPROVE' }).expect(409);
    expect(errorOf(late).code).toBe(ErrorCode.APPROVAL_EXPIRED);

    expect(await ctx.app.get(ApprovalExpiryJob).runOnce()).toBe(1);
    const rows = await ctx.prisma.approvalRequest.findMany();
    expect(rows.map((r) => r.status).sort()).toEqual(['EXPIRED', 'EXPIRED']);
    expect(calls).toHaveLength(0);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'APPROVAL_EXPIRED', resourceId: { in: [decidedLate.id, swept.id] } } }),
    ).toBe(2);
  });

  it('records FAILED and answers 422 RESOLUTION_ACTION_FAILED when the owning module refuses', async () => {
    const approval = await request_();
    refuseNext = new ApiException(ErrorCode.CONFLICT, 'Settlement is already paid.');
    const failed = await decide(checker.accessToken, approval.id, { decision: 'APPROVE' }).expect(422);
    expect(errorOf(failed).code).toBe(ErrorCode.RESOLUTION_ACTION_FAILED);
    const stored = body(await get(checker.accessToken, `${APPROVALS}/${approval.id}`).expect(200));
    expect(stored).toMatchObject({
      status: 'FAILED',
      executionError: { code: 'CONFLICT', message: 'Settlement is already paid.' },
    });
    await decide(checker.accessToken, approval.id, { decision: 'APPROVE' }).expect(422);
    expect(calls).toHaveLength(1);
  });

  it('runs an action at once when it is not configured for approval', async () => {
    await ctx.prisma.platformConfig.updateMany({ data: { value: [] } });
    await loader.refresh();
    const result = await gate.submit({
      actionType: ACTION,
      payload: { settlementId: 'set-1' },
      makerUserId: maker.userId,
      makerPermissions: [PERMISSION],
      idempotencyKey: 'direct',
    });
    expect(result).toEqual({ outcome: 'EXECUTED', result: { paidSettlementId: 'set-1', by: maker.userId } });
    expect(await ctx.prisma.approvalRequest.count()).toBe(0);
  });

  it('governs the configuration: only registered production types, and ttlHours within 1–720', async () => {
    const superAdmin = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    const put = (key: string, payload: object) =>
      request(ctx.server).put(`/admin/config/approvals/${key}`).set(...auth(superAdmin)).send(payload);

    const unknown = await put('makerCheckerActions', { valueType: 'JSON', value: [ACTION] }).expect(422);
    expect(errorOf(unknown).code).toBe(ErrorCode.CONFIG_VALIDATION_FAILED);
    await put('makerCheckerActions', { valueType: 'JSON', value: [] }).expect(200);
    await put('ttlHours', { valueType: 'INTEGER', value: 0 }).expect(422);
    await put('ttlHours', { valueType: 'INTEGER', value: 24 }).expect(200);
    // Finance cannot change which actions need a checker.
    await request(ctx.server)
      .put('/admin/config/approvals/makerCheckerActions')
      .set(...auth(maker.accessToken))
      .send({ valueType: 'JSON', value: [] })
      .expect(403);
  });
});
