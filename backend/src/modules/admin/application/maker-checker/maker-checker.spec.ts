import { ApprovalEntityType } from '@prisma/client';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../../prisma/rbac-catalog';
import {
  readMakerCheckerActions,
  APPROVALS_MAKER_CHECKER_ACTIONS_ENV,
} from '../../../../shared/config/approvals.config';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { PERMISSIONS_KEY } from '../../../../shared/rbac/permissions.decorator';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import {
  ApprovalDecision,
  ApprovalRequestProps,
  ApprovalStatus,
} from '../../domain/maker-checker/approval-request';
import {
  ApprovalInsertConflict,
  ApprovalPage,
  ApprovalSearchCriteria,
  ApprovalTransition,
  IApprovalRequestRepository,
  NewApprovalRequest,
} from '../../domain/maker-checker/approval-request.repository';
import {
  MakerCheckerAction,
  MakerCheckerActionRegistry,
  MakerCheckerExecutionContext,
} from '../../domain/maker-checker/maker-checker-action';
import { ConfigCatalogue } from '../../domain/services/config-catalogue';
import { ConfigKey } from '../../domain/value-objects/config-key.vo';
import { ConfigValue } from '../../domain/value-objects/config-value.vo';
import { ConfigValueType } from '../../domain/enums';
import { AdminApprovalsController } from '../../interface/controllers/admin-approvals.controller';
import { toApprovalView } from './approval-queries';
import { DecideApprovalCommand } from './decide-approval.command';
import { ExpireApprovalService } from './expire-approval.service';
import { MakerCheckerGate } from './maker-checker-gate.service';

/** An in-memory `approval_requests` with the table's two unique rules and conditional updates. */
class InMemoryApprovals implements IApprovalRequestRepository {
  rows = new Map<string, ApprovalRequestProps>();

  async insert(
    request: NewApprovalRequest,
  ): Promise<{ created: ApprovalRequestProps } | { conflict: ApprovalInsertConflict }> {
    for (const row of this.rows.values()) {
      if (
        row.requestedByUserId === request.requestedByUserId &&
        row.actionType === request.actionType &&
        row.makerIdempotencyKey === request.makerIdempotencyKey
      ) {
        return { conflict: 'MAKER_KEY' };
      }
      if (
        row.status === ApprovalStatus.PENDING &&
        row.actionType === request.actionType &&
        row.entityId === request.entityId
      ) {
        return { conflict: 'PENDING_FOR_TARGET' };
      }
    }
    const now = new Date();
    const created: ApprovalRequestProps = {
      ...request,
      status: ApprovalStatus.PENDING,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      executedAt: null,
      executionResult: null,
      executionError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(created.id, created);
    return { created: { ...created } };
  }

  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async findByMakerKey(maker: string, actionType: string, key: string) {
    const row = [...this.rows.values()].find(
      (r) => r.requestedByUserId === maker && r.actionType === actionType && r.makerIdempotencyKey === key,
    );
    return row ? { ...row } : null;
  }

  async findPendingForTarget(actionType: string, entityId: string) {
    const row = [...this.rows.values()].find(
      (r) => r.status === ApprovalStatus.PENDING && r.actionType === actionType && r.entityId === entityId,
    );
    return row ? { ...row } : null;
  }

  async transition(
    id: string,
    from: ApprovalStatus,
    change: ApprovalTransition,
    _tx?: unknown,
    options?: { unexecuted?: boolean },
  ) {
    const row = this.rows.get(id);
    if (!row || row.status !== from || (options?.unexecuted && row.executedAt)) {
      return null;
    }
    const updated = { ...row, ...change, updatedAt: new Date() } as ApprovalRequestProps;
    this.rows.set(id, updated);
    return { ...updated };
  }

  async search(_criteria: ApprovalSearchCriteria, page: number, size: number): Promise<ApprovalPage> {
    return { items: [...this.rows.values()], total: this.rows.size, page, size };
  }

  async findDueForExpiry(now: Date) {
    return [...this.rows.values()].filter(
      (r) => r.status === ApprovalStatus.PENDING && r.expiresAt.getTime() <= now.getTime(),
    );
  }
}

const ACTION = 'TEST_PAYOUT';
const PERMISSION = 'finance:settlement:any';
const MAKER = 'maker-1';
const CHECKER = 'checker-1';

function setup(options: { configured?: string[]; ttlHours?: number } = {}) {
  const approvals = new InMemoryApprovals();
  const uow = { run: <T>(work: (tx: unknown) => Promise<T>) => work({}) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) };
  const outbox = { write: jest.fn().mockResolvedValue(undefined) };
  const settings: Record<string, unknown> = {
    'approvals.makerCheckerActions': options.configured ?? [ACTION],
    'approvals.ttlHours': options.ttlHours ?? 72,
  };
  const config = {
    get: (key: string) => settings[key],
    getOrThrow: (key: string) => settings[key],
    isFeatureEnabled: () => false,
  };
  const execute = jest.fn<Promise<Record<string, unknown>>, [Record<string, unknown>, MakerCheckerExecutionContext]>(
    async (payload) => ({ paid: payload.settlementId }),
  );
  const action: MakerCheckerAction = {
    type: ACTION,
    entityType: ApprovalEntityType.PAYOUT,
    requiredPermission: PERMISSION,
    describe: (payload) => ({
      entityId: String(payload.settlementId),
      summary: `Pay settlement ${String(payload.settlementId)}`,
    }),
    execute,
  };
  const registry = new MakerCheckerActionRegistry();
  registry.register(action);

  const gate = new MakerCheckerGate(
    registry,
    approvals,
    uow,
    config as never,
    audit as never,
    outbox as never,
  );
  const expiry = new ExpireApprovalService(approvals, uow, audit as never, outbox as never);
  const decide = new DecideApprovalCommand(
    approvals,
    uow,
    registry,
    expiry,
    audit as never,
    outbox as never,
  );
  return { approvals, audit, outbox, execute, gate, expiry, decide, settings, registry };
}

const submitInput = (overrides: Partial<Parameters<MakerCheckerGate['submit']>[0]> = {}) => ({
  actionType: ACTION,
  payload: { settlementId: 'set-1' },
  makerUserId: MAKER,
  makerPermissions: [PERMISSION],
  idempotencyKey: 'key-1',
  reason: 'Month end',
  ...overrides,
});

async function pending(ctx: ReturnType<typeof setup>): Promise<ApprovalRequestProps> {
  const result = await ctx.gate.submit(submitInput());
  if (result.outcome !== 'PENDING_APPROVAL') throw new Error('expected pending');
  return result.approval;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiException) return err.code;
    throw err;
  }
  throw new Error('expected a rejection');
}

const auditActions = (ctx: ReturnType<typeof setup>) =>
  ctx.audit.record.mock.calls.map((call) => (call[0] as { action: string }).action);

describe('Maker-checker (Work 82)', () => {
  describe('MakerCheckerGate', () => {
    it('runs an action that is not configured at once, with the maker as actor and key', async () => {
      const ctx = setup({ configured: [] });
      const result = await ctx.gate.submit(submitInput());
      expect(result).toEqual({ outcome: 'EXECUTED', result: { paid: 'set-1' } });
      expect(ctx.execute).toHaveBeenCalledWith(
        { settlementId: 'set-1' },
        expect.objectContaining({ approvalId: null, idempotencyKey: 'key-1', actorUserId: MAKER }),
      );
      expect(ctx.approvals.rows.size).toBe(0);
    });

    it('records a PENDING request for a configured action, audited and on the outbox, and does not run it', async () => {
      const ctx = setup();
      const approval = await pending(ctx);
      expect(approval).toMatchObject({
        status: ApprovalStatus.PENDING,
        actionType: ACTION,
        entityType: ApprovalEntityType.PAYOUT,
        entityId: 'set-1',
        requestedByUserId: MAKER,
        requiredPermission: PERMISSION,
        summary: 'Pay settlement set-1',
        reason: 'Month end',
      });
      expect(approval.expiresAt.getTime() - approval.createdAt.getTime()).toBeGreaterThan(71 * 3600_000);
      expect(ctx.execute).not.toHaveBeenCalled();
      expect(auditActions(ctx)).toEqual(['APPROVAL_REQUESTED']);
      expect(ctx.outbox.write).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'admin.approval.requested' }),
        expect.anything(),
      );
    });

    it('uses approvals.ttlHours for the expiry', async () => {
      const ctx = setup({ ttlHours: 2 });
      const approval = await pending(ctx);
      expect(approval.expiresAt.getTime() - approval.createdAt.getTime()).toBeLessThanOrEqual(2 * 3600_000 + 1000);
    });

    it('returns the same request for a retry with the same key and payload', async () => {
      const ctx = setup();
      const first = await pending(ctx);
      const again = await ctx.gate.submit(submitInput());
      expect(again).toEqual({ outcome: 'PENDING_APPROVAL', approval: first });
      expect(ctx.approvals.rows.size).toBe(1);
      expect(auditActions(ctx)).toEqual(['APPROVAL_REQUESTED']);
    });

    it('refuses the same key for a different payload with IDEMPOTENCY_CONFLICT', async () => {
      const ctx = setup();
      await pending(ctx);
      expect(await codeOf(ctx.gate.submit(submitInput({ payload: { settlementId: 'set-2' } })))).toBe(
        ErrorCode.IDEMPOTENCY_CONFLICT,
      );
    });

    it('refuses a second open request for the same action and target with CONFLICT', async () => {
      const ctx = setup();
      await pending(ctx);
      expect(
        await codeOf(ctx.gate.submit(submitInput({ makerUserId: 'maker-2', idempotencyKey: 'other' }))),
      ).toBe(ErrorCode.CONFLICT);
    });

    it('refuses a maker without the action permission', async () => {
      const ctx = setup();
      expect(await codeOf(ctx.gate.submit(submitInput({ makerPermissions: ['finance:report:any'] })))).toBe(
        ErrorCode.FORBIDDEN,
      );
      expect(ctx.approvals.rows.size).toBe(0);
    });

    it('refuses an unknown action and a missing idempotency key', async () => {
      const ctx = setup();
      expect(await codeOf(ctx.gate.submit(submitInput({ actionType: 'NOPE' })))).toBe(ErrorCode.VALIDATION_ERROR);
      expect(await codeOf(ctx.gate.submit(submitInput({ idempotencyKey: ' ' })))).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe('DecideApprovalCommand', () => {
    const decideInput = (approvalId: string, overrides: Record<string, unknown> = {}) => ({
      approvalId,
      checkerUserId: CHECKER,
      checkerPermissions: [PERMISSION, 'approval:read:any'],
      decision: ApprovalDecision.APPROVE,
      reason: null,
      ...overrides,
    });

    it('refuses the maker deciding their own request, even with every permission', async () => {
      const ctx = setup();
      const approval = await pending(ctx);
      expect(
        await codeOf(ctx.decide.execute(decideInput(approval.id, { checkerUserId: MAKER, checkerPermissions: ['*'] }))),
      ).toBe(ErrorCode.MAKER_CHECKER_SELF_APPROVAL);
      expect(ctx.execute).not.toHaveBeenCalled();
      expect(ctx.approvals.rows.get(approval.id)!.status).toBe(ApprovalStatus.PENDING);
    });

    it('refuses a checker without the action permission', async () => {
      const ctx = setup();
      const approval = await pending(ctx);
      expect(
        await codeOf(ctx.decide.execute(decideInput(approval.id, { checkerPermissions: ['approval:read:any'] }))),
      ).toBe(ErrorCode.FORBIDDEN);
    });

    it('requires a reason to reject, and records the rejection with both parties', async () => {
      const ctx = setup();
      const approval = await pending(ctx);
      expect(
        await codeOf(ctx.decide.execute(decideInput(approval.id, { decision: ApprovalDecision.REJECT, reason: '  ' }))),
      ).toBe(ErrorCode.VALIDATION_ERROR);

      const rejected = await ctx.decide.execute(
        decideInput(approval.id, { decision: ApprovalDecision.REJECT, reason: 'Amount looks wrong' }),
      );
      expect(rejected).toMatchObject({
        status: ApprovalStatus.REJECTED,
        decidedByUserId: CHECKER,
        decisionNote: 'Amount looks wrong',
      });
      expect(ctx.execute).not.toHaveBeenCalled();
      const entry = ctx.audit.record.mock.calls[1][0] as { action: string; context: Record<string, unknown> };
      expect(entry.action).toBe('APPROVAL_REJECTED');
      expect(entry.context).toMatchObject({ requestedBy: MAKER, decidedBy: CHECKER, reason: 'Amount looks wrong' });
    });

    it('approves, runs the action once with approval:<id> and the checker as actor, and records the outcome', async () => {
      const ctx = setup();
      const approval = await pending(ctx);
      const done = await ctx.decide.execute(decideInput(approval.id, { reason: 'Checked' }));
      expect(done).toMatchObject({
        status: ApprovalStatus.APPROVED,
        decidedByUserId: CHECKER,
        executionResult: { paid: 'set-1' },
      });
      expect(done.executedAt).toBeInstanceOf(Date);
      expect(ctx.execute).toHaveBeenCalledTimes(1);
      expect(ctx.execute.mock.calls[0][1]).toMatchObject({
        approvalId: approval.id,
        idempotencyKey: `approval:${approval.id}`,
        makerUserId: MAKER,
        actorUserId: CHECKER,
      });
      expect(auditActions(ctx)).toEqual(['APPROVAL_REQUESTED', 'APPROVAL_APPROVED', 'APPROVAL_EXECUTED']);
      expect(ctx.outbox.write).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'admin.approval.decided' }),
        expect.anything(),
      );
    });

    it('answers a repeated approval with the stored outcome and does not run the action again', async () => {
      const ctx = setup();
      const approval = await pending(ctx);
      const first = await ctx.decide.execute(decideInput(approval.id));
      const second = await ctx.decide.execute(decideInput(approval.id));
      expect(second).toEqual(first);
      expect(ctx.execute).toHaveBeenCalledTimes(1);
    });

    it('refuses to approve a rejected request, and to reject an approved one', async () => {
      const ctx = setup();
      const a = await pending(ctx);
      await ctx.decide.execute(decideInput(a.id, { decision: ApprovalDecision.REJECT, reason: 'No' }));
      expect(await codeOf(ctx.decide.execute(decideInput(a.id)))).toBe(ErrorCode.APPROVAL_ALREADY_DECIDED);

      const b = (await ctx.gate.submit(submitInput({ idempotencyKey: 'key-2', payload: { settlementId: 'set-9' } })))
        .outcome === 'PENDING_APPROVAL'
        ? [...ctx.approvals.rows.values()].find((r) => r.entityId === 'set-9')!
        : null;
      await ctx.decide.execute(decideInput(b!.id));
      expect(
        await codeOf(ctx.decide.execute(decideInput(b!.id, { decision: ApprovalDecision.REJECT, reason: 'Late' }))),
      ).toBe(ErrorCode.APPROVAL_ALREADY_DECIDED);
    });

    it('expires a request past its expiry instead of deciding it, and audits the expiry', async () => {
      const ctx = setup();
      const approval = await pending(ctx);
      ctx.approvals.rows.get(approval.id)!.expiresAt = new Date(Date.now() - 1000);
      expect(await codeOf(ctx.decide.execute(decideInput(approval.id)))).toBe(ErrorCode.APPROVAL_EXPIRED);
      expect(ctx.approvals.rows.get(approval.id)!.status).toBe(ApprovalStatus.EXPIRED);
      expect(ctx.execute).not.toHaveBeenCalled();
      expect(auditActions(ctx)).toEqual(['APPROVAL_REQUESTED', 'APPROVAL_EXPIRED']);
      expect(await codeOf(ctx.decide.execute(decideInput(approval.id)))).toBe(ErrorCode.APPROVAL_EXPIRED);
    });

    it('marks the request FAILED when the owning module refuses, and repeats that answer', async () => {
      const ctx = setup();
      ctx.execute.mockRejectedValueOnce(new ApiException(ErrorCode.CONFLICT, 'Settlement already paid.'));
      const approval = await pending(ctx);
      expect(await codeOf(ctx.decide.execute(decideInput(approval.id)))).toBe(ErrorCode.RESOLUTION_ACTION_FAILED);
      const stored = ctx.approvals.rows.get(approval.id)!;
      expect(stored.status).toBe(ApprovalStatus.FAILED);
      expect(stored.executionError).toEqual({ code: 'CONFLICT', message: 'Settlement already paid.' });
      expect(auditActions(ctx)).toEqual(['APPROVAL_REQUESTED', 'APPROVAL_APPROVED', 'APPROVAL_EXECUTION_FAILED']);
      expect(await codeOf(ctx.decide.execute(decideInput(approval.id)))).toBe(ErrorCode.RESOLUTION_ACTION_FAILED);
      expect(ctx.execute).toHaveBeenCalledTimes(1);
    });

    it('leaves the request APPROVED after an infrastructure failure, and resumes with the same key', async () => {
      const ctx = setup();
      ctx.execute.mockRejectedValueOnce(new Error('connection reset'));
      const approval = await pending(ctx);
      await expect(ctx.decide.execute(decideInput(approval.id))).rejects.toThrow('connection reset');
      const stored = ctx.approvals.rows.get(approval.id)!;
      expect(stored.status).toBe(ApprovalStatus.APPROVED);
      expect(stored.executedAt).toBeNull();

      const resumed = await ctx.decide.execute(decideInput(approval.id));
      expect(resumed.executedAt).toBeInstanceOf(Date);
      expect(ctx.execute).toHaveBeenCalledTimes(2);
      expect(ctx.execute.mock.calls.map((c) => c[1].idempotencyKey)).toEqual([
        `approval:${approval.id}`,
        `approval:${approval.id}`,
      ]);
    });

    it('answers NOT_FOUND for an unknown request', async () => {
      const ctx = setup();
      expect(await codeOf(ctx.decide.execute(decideInput('00000000-0000-0000-0000-000000000000')))).toBe(
        ErrorCode.NOT_FOUND,
      );
    });
  });

  describe('expiry sweep', () => {
    it('expires only PENDING requests past their expiry, once', async () => {
      const ctx = setup();
      const due = await pending(ctx);
      ctx.approvals.rows.get(due.id)!.expiresAt = new Date(Date.now() - 1);
      await ctx.gate.submit(submitInput({ idempotencyKey: 'k2', payload: { settlementId: 'set-2' } }));
      expect(await ctx.expiry.expireDue()).toBe(1);
      expect(await ctx.expiry.expireDue()).toBe(0);
      expect([...ctx.approvals.rows.values()].map((r) => r.status).sort()).toEqual([
        ApprovalStatus.EXPIRED,
        ApprovalStatus.PENDING,
      ]);
    });
  });

  describe('read model', () => {
    it('offers a decision only to a permitted non-maker while the request is open', async () => {
      const ctx = setup();
      const approval = await pending(ctx);
      const now = new Date();
      expect(toApprovalView(approval, { userId: CHECKER, permissions: [PERMISSION] }, now).canDecide).toBe(true);
      expect(toApprovalView(approval, { userId: MAKER, permissions: ['*'] }, now)).toMatchObject({
        canDecide: false,
        isOwnRequest: true,
      });
      expect(toApprovalView(approval, { userId: CHECKER, permissions: ['approval:read:any'] }, now).canDecide).toBe(false);
      const late = new Date(approval.expiresAt.getTime() + 1);
      expect(toApprovalView(approval, { userId: CHECKER, permissions: [PERMISSION] }, late)).toMatchObject({
        status: ApprovalStatus.EXPIRED,
        canDecide: false,
      });
    });
  });

  describe('configuration', () => {
    it('declares approvals.makerCheckerActions (a list of registered types) and approvals.ttlHours (1–720)', () => {
      expect(ConfigCatalogue.find('approvals', 'makerCheckerActions')).toMatchObject({
        type: ConfigValueType.JSON,
        // Work 83's registered types.
        allowed: ['SETTLEMENT_APPROVE', 'SETTLEMENT_PAYOUT', 'PAYOUT_BENEFICIARY_VERIFY', 'REFUND_HIGH_VALUE'],
      });
      expect(ConfigCatalogue.find('approvals', 'ttlHours')).toMatchObject({
        type: ConfigValueType.INTEGER,
        min: 1,
        max: 720,
      });
    });

    it('accepts the empty list and refuses an unregistered action type', () => {
      const key = ConfigKey.of('approvals', 'makerCheckerActions');
      expect(ConfigValue.of(key, ConfigValueType.JSON, []).value).toEqual([]);
      expect(ConfigValue.of(key, ConfigValueType.JSON, ['SETTLEMENT_PAYOUT']).value).toEqual(['SETTLEMENT_PAYOUT']);
      for (const bad of [['TEST_PAYOUT'], {}, ['']]) {
        expect(() => ConfigValue.of(key, ConfigValueType.JSON, bad)).toThrow(ApiException);
      }
    });

    it('refuses duplicates in a list drawn from a closed set', () => {
      const key = {
        path: 'approvals.makerCheckerActions',
        definition: { ...ConfigCatalogue.find('approvals', 'makerCheckerActions')!, allowed: ['A', 'B'] },
      } as unknown as ConfigKey;
      expect(ConfigValue.of(key, ConfigValueType.JSON, ['A', 'B']).value).toEqual(['A', 'B']);
      expect(() => ConfigValue.of(key, ConfigValueType.JSON, ['A', 'A'])).toThrow(ApiException);
    });

    it('parses APPROVALS_MAKER_CHECKER_ACTIONS and fails on an unregistered type', () => {
      // Unset or blank: every registered money action needs a checker (Work 83's secure default).
      const all = ['SETTLEMENT_APPROVE', 'SETTLEMENT_PAYOUT', 'PAYOUT_BENEFICIARY_VERIFY', 'REFUND_HIGH_VALUE'];
      expect(readMakerCheckerActions({})).toEqual(all);
      expect(readMakerCheckerActions({ [APPROVALS_MAKER_CHECKER_ACTIONS_ENV]: ' ' })).toEqual(all);
      expect(readMakerCheckerActions({ [APPROVALS_MAKER_CHECKER_ACTIONS_ENV]: 'none' })).toEqual([]);
      expect(readMakerCheckerActions({ [APPROVALS_MAKER_CHECKER_ACTIONS_ENV]: 'A, B,A' }, ['A', 'B'])).toEqual([
        'A',
        'B',
      ]);
      expect(() => readMakerCheckerActions({ [APPROVALS_MAKER_CHECKER_ACTIONS_ENV]: 'TEST_PAYOUT' })).toThrow(
        /unregistered/,
      );
    });
  });

  describe('HTTP surface and RBAC', () => {
    it('serves /admin/approvals behind approval:read:any', () => {
      expect(Reflect.getMetadata('path', AdminApprovalsController)).toBe('admin/approvals');
      for (const method of ['search', 'listActions', 'detail', 'decideOne'] as const) {
        expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminApprovalsController.prototype[method])).toEqual([
          'approval:read:any',
        ]);
      }
    });

    it('grants approval:read:any to ADMIN and FINANCE_OFFICER (SUPER_ADMIN by wildcard) and nobody else', () => {
      expect(PERMISSIONS.find((p) => p.key === 'approval:read:any')).toEqual({
        key: 'approval:read:any',
        resource: 'approval',
        action: 'read',
        scope: 'any',
      });
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'approval:read:any') }).toEqual({
          role,
          ok: ['ADMIN', 'FINANCE_OFFICER', 'SUPER_ADMIN'].includes(role),
        });
      }
      // Reading the queue grants no action.
      expect(hasPermission(['approval:read:any'], PERMISSION)).toBe(false);
    });

    it('registers each action type once', () => {
      const registry = setup().registry;
      expect(() => registry.register(registry.find(ACTION)!)).toThrow(/already registered/);
    });
  });
});
