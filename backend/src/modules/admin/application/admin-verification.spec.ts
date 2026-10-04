import { AuditService } from '../../../shared/audit/audit.service';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { ApiException } from '../../../shared/errors/api-exception';
import {
  IIdentityAdminPort,
  VerificationDecisionResult,
  VerificationDetailView,
  VerificationStatus,
  VerificationSummaryView,
  VerificationType,
} from '../../identity/application/ports/inbound/identity-admin.port';
import { AccountStatus, PrimaryRole } from '../../identity/domain/enums';
import {
  ADMIN_VERIFICATION_APPROVED,
  ApproveVerificationCommand,
} from './commands/approve-verification.command';
import {
  ADMIN_VERIFICATION_REJECTED,
  RejectVerificationCommand,
} from './commands/reject-verification.command';
import { GetVerificationQuery } from './queries/get-verification.query';
import {
  DEFAULT_VERIFICATION_PAGE_SIZE,
  ListVerificationQueueQuery,
  MAX_VERIFICATION_PAGE_SIZE,
} from './queries/list-verification-queue.query';
import { computeAging } from './support/verification-aging';

/**
 * Module 16 Work 02's application layer, with Module 01 behind a fake port.
 *
 * The claims that belong here are about what this module *sends* and *records*: that the reviewer
 * forwarded to Module 01 is the authenticated actor and nothing else, that the queue defaults to
 * the work waiting, that aging is arithmetic on the timestamps Module 01 returns, and that an
 * audit entry is written for a decision Module 01 accepted and not for one it refused. Whether
 * Module 01 really refuses a second decision, and whether two concurrent decisions really resolve
 * to one, are database claims and are made against PostgreSQL in
 * `test/admin/admin-verification.e2e-spec.ts`.
 */
describe('Admin verification management (application)', () => {
  const NOW = new Date('2026-09-17T12:00:00.000Z');

  function summary(overrides: Partial<VerificationSummaryView> = {}): VerificationSummaryView {
    return {
      requestId: 'req-1',
      userId: 'user-1',
      organizationId: null,
      type: VerificationType.DRIVER_DOCS,
      status: VerificationStatus.PENDING,
      documentCount: 2,
      submittedAt: new Date('2026-09-17T10:00:00.000Z'),
      reviewedAt: null,
      ...overrides,
    };
  }

  function detail(overrides: Partial<VerificationDetailView> = {}): VerificationDetailView {
    return {
      ...summary(),
      documents: [
        { kind: 'DRIVING_LICENSE', storageRef: 'enc://docs/abc', expiresAt: null },
        { kind: 'VEHICLE_REGISTRATION', storageRef: 'enc://docs/def', expiresAt: '2027-01-01' },
      ],
      hasFaydaId: false,
      reviewerId: null,
      rejectReason: null,
      expiresAt: null,
      applicant: {
        userId: 'user-1',
        primaryRole: PrimaryRole.DRIVER,
        accountStatus: AccountStatus.ACTIVE,
      },
      ...overrides,
    };
  }

  function decision(overrides: Partial<VerificationDecisionResult> = {}): VerificationDecisionResult {
    return {
      requestId: 'req-1',
      type: VerificationType.DRIVER_DOCS,
      previousStatus: VerificationStatus.PENDING,
      status: VerificationStatus.APPROVED,
      subjectUserId: 'user-1',
      organizationId: null,
      reviewedAt: NOW,
      expiresAt: null,
      ...overrides,
    };
  }

  let identity: jest.Mocked<IIdentityAdminPort>;
  let audit: jest.Mocked<AuditService>;

  beforeEach(() => {
    identity = {
      listUsers: jest.fn(),
      getUser: jest.fn(),
      suspendUser: jest.fn(),
      reactivateUser: jest.fn(),
      listRoles: jest.fn(),
      listUserRoles: jest.fn(),
      assignRole: jest.fn(),
      revokeRole: jest.fn(),
      listVerificationRequests: jest.fn(),
      getVerificationRequest: jest.fn(),
      approveVerification: jest.fn(),
      rejectVerification: jest.fn(),
    };
    audit = {
      record: jest.fn().mockResolvedValue({ id: 'audit-1', hash: 'h' }),
    } as unknown as jest.Mocked<AuditService>;
  });

  // -------------------------------------------------------------------------------------------
  // 1. Aging — read-side arithmetic, nothing stored
  // -------------------------------------------------------------------------------------------

  describe('computeAging', () => {
    it('reports how long an open request has been waiting, and since when', () => {
      const aging = computeAging(summary(), NOW);
      expect(aging.pendingSince).toEqual(new Date('2026-09-17T10:00:00.000Z'));
      expect(aging.ageSeconds).toBe(2 * 3600);
    });

    it('reports how long a decided request took, and no longer calls it pending', () => {
      const aging = computeAging(
        summary({
          status: VerificationStatus.APPROVED,
          reviewedAt: new Date('2026-09-17T10:30:00.000Z'),
        }),
        NOW,
      );
      expect(aging.pendingSince).toBeNull();
      expect(aging.ageSeconds).toBe(30 * 60);
    });

    it('never reports a negative age for a submission stamped slightly in the future', () => {
      const aging = computeAging(
        summary({ submittedAt: new Date('2026-09-17T12:00:05.000Z') }),
        NOW,
      );
      expect(aging.ageSeconds).toBe(0);
    });

    it('truncates to whole seconds', () => {
      const aging = computeAging(
        summary({ submittedAt: new Date('2026-09-17T11:59:58.400Z') }),
        NOW,
      );
      expect(aging.ageSeconds).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Queue
  // -------------------------------------------------------------------------------------------

  describe('ListVerificationQueueQuery', () => {
    let query: ListVerificationQueueQuery;

    beforeEach(() => {
      query = new ListVerificationQueueQuery(identity);
      identity.listVerificationRequests.mockResolvedValue({
        items: [summary()],
        total: 1,
        page: 1,
        size: DEFAULT_VERIFICATION_PAGE_SIZE,
      });
    });

    it('asks Module 01 for PENDING requests when no status is given', async () => {
      await query.execute({});
      expect(identity.listVerificationRequests).toHaveBeenCalledWith(
        expect.objectContaining({ status: VerificationStatus.PENDING }),
        1,
        DEFAULT_VERIFICATION_PAGE_SIZE,
      );
    });

    it('forwards an explicit status, so history is reachable', async () => {
      await query.execute({ status: VerificationStatus.REJECTED });
      expect(identity.listVerificationRequests).toHaveBeenCalledWith(
        expect.objectContaining({ status: VerificationStatus.REJECTED }),
        1,
        DEFAULT_VERIFICATION_PAGE_SIZE,
      );
    });

    it('forwards every filter Module 01 supports, and nothing it does not', async () => {
      const from = new Date('2026-09-01T00:00:00.000Z');
      const to = new Date('2026-09-18T00:00:00.000Z');
      await query.execute({
        type: VerificationType.PHARMACY_LICENSE,
        userId: 'user-9',
        organizationId: 'org-9',
        submittedFrom: from,
        submittedTo: to,
      });
      const [filter] = identity.listVerificationRequests.mock.calls[0];
      expect(filter).toEqual({
        status: VerificationStatus.PENDING,
        type: VerificationType.PHARMACY_LICENSE,
        userId: 'user-9',
        organizationId: 'org-9',
        submittedFrom: from,
        submittedTo: to,
      });
    });

    it('clamps the page size to the ceiling and floors a fractional page', async () => {
      await query.execute({ page: 2.7, size: 10_000 });
      expect(identity.listVerificationRequests).toHaveBeenCalledWith(
        expect.anything(),
        2,
        MAX_VERIFICATION_PAGE_SIZE,
      );
    });

    it('falls back to defaults for a non-positive page or size', async () => {
      await query.execute({ page: 0, size: -5 });
      expect(identity.listVerificationRequests).toHaveBeenCalledWith(
        expect.anything(),
        1,
        DEFAULT_VERIFICATION_PAGE_SIZE,
      );
    });

    it('attaches aging to every row and passes the page through unchanged', async () => {
      const result = await query.execute({}, NOW);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.items[0].aging).toEqual({
        pendingSince: new Date('2026-09-17T10:00:00.000Z'),
        ageSeconds: 7200,
      });
      expect(result.items[0].requestId).toBe('req-1');
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Detail
  // -------------------------------------------------------------------------------------------

  describe('GetVerificationQuery', () => {
    let query: GetVerificationQuery;

    beforeEach(() => {
      query = new GetVerificationQuery(identity);
    });

    it('returns Module 01 projection plus aging', async () => {
      identity.getVerificationRequest.mockResolvedValue(detail());
      const view = await query.execute('req-1', NOW);
      expect(view.documents).toHaveLength(2);
      expect(view.documents[0].storageRef).toBe('enc://docs/abc');
      expect(view.hasFaydaId).toBe(false);
      expect(view.applicant?.primaryRole).toBe(PrimaryRole.DRIVER);
      expect(view.aging.ageSeconds).toBe(7200);
    });

    it('answers NOT_FOUND for an id Module 01 does not know', async () => {
      identity.getVerificationRequest.mockResolvedValue(null);
      await expect(query.execute('missing')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('carries no field that could hold the Fayda identifier', async () => {
      identity.getVerificationRequest.mockResolvedValue(detail({ hasFaydaId: true }));
      const view = await query.execute('req-1', NOW);
      const keys = Object.keys(view);
      expect(keys).not.toContain('faydaIdEncrypted');
      expect(keys).not.toContain('faydaId');
      expect(view.hasFaydaId).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Approve
  // -------------------------------------------------------------------------------------------

  describe('ApproveVerificationCommand', () => {
    let command: ApproveVerificationCommand;

    beforeEach(() => {
      command = new ApproveVerificationCommand(identity, audit);
      identity.approveVerification.mockResolvedValue(decision());
    });

    it('forwards the authenticated actor to Module 01 as the reviewer', async () => {
      const expiry = new Date('2027-06-30T00:00:00.000Z');
      await command.execute({
        actorUserId: 'admin-1',
        requestId: 'req-1',
        expiresAt: expiry,
        reason: 'Documents verified against registry',
        ip: '10.0.0.1',
      });
      expect(identity.approveVerification).toHaveBeenCalledWith({
        requestId: 'req-1',
        reviewerId: 'admin-1',
        expiresAt: expiry,
        ip: '10.0.0.1',
      });
    });

    it('records the admin action with the transition, the reason and no document data', async () => {
      identity.approveVerification.mockResolvedValue(
        decision({ expiresAt: new Date('2027-06-30T00:00:00.000Z') }),
      );
      await command.execute({
        actorUserId: 'admin-1',
        requestId: 'req-1',
        expiresAt: new Date('2027-06-30T00:00:00.000Z'),
        reason: 'Documents verified against registry',
        ip: '10.0.0.1',
      });

      expect(audit.record).toHaveBeenCalledTimes(1);
      const [entry] = audit.record.mock.calls[0];
      expect(entry).toMatchObject({
        actorUserId: 'admin-1',
        action: ADMIN_VERIFICATION_APPROVED,
        resourceType: 'verification_request',
        resourceId: 'req-1',
        ip: '10.0.0.1',
      });
      expect(entry.context).toEqual({
        verificationType: VerificationType.DRIVER_DOCS,
        previousStatus: VerificationStatus.PENDING,
        status: VerificationStatus.APPROVED,
        subjectUserId: 'user-1',
        organizationId: null,
        expiresAt: '2027-06-30T00:00:00.000Z',
        reason: 'Documents verified against registry',
        decidedAt: NOW.toISOString(),
      });
      expect(JSON.stringify(entry)).not.toContain('storageRef');
    });

    it('returns the decision Module 01 reported', async () => {
      const result = await command.execute({
        actorUserId: 'admin-1',
        requestId: 'req-1',
        expiresAt: null,
        reason: null,
        ip: null,
      });
      expect(result.status).toBe(VerificationStatus.APPROVED);
      expect(result.previousStatus).toBe(VerificationStatus.PENDING);
    });

    it('writes no audit entry when Module 01 refuses the decision', async () => {
      identity.approveVerification.mockRejectedValue(
        new ApiException(ErrorCode.BUSINESS_RULE_VIOLATION, 'already decided'),
      );
      await expect(
        command.execute({
          actorUserId: 'admin-1',
          requestId: 'req-1',
          expiresAt: null,
          reason: null,
          ip: null,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Reject
  // -------------------------------------------------------------------------------------------

  describe('RejectVerificationCommand', () => {
    let command: RejectVerificationCommand;

    beforeEach(() => {
      command = new RejectVerificationCommand(identity, audit);
      identity.rejectVerification.mockResolvedValue(
        decision({ status: VerificationStatus.REJECTED }),
      );
    });

    it('forwards the actor and the reason verbatim to Module 01', async () => {
      await command.execute({
        actorUserId: 'admin-2',
        requestId: 'req-1',
        reason: 'Licence number does not match the registry',
        ip: null,
      });
      expect(identity.rejectVerification).toHaveBeenCalledWith({
        requestId: 'req-1',
        reviewerId: 'admin-2',
        reason: 'Licence number does not match the registry',
        ip: null,
      });
    });

    it('records the admin action with the reason and the transition', async () => {
      await command.execute({
        actorUserId: 'admin-2',
        requestId: 'req-1',
        reason: 'Licence number does not match the registry',
        ip: '10.0.0.2',
      });
      const [entry] = audit.record.mock.calls[0];
      expect(entry).toMatchObject({
        actorUserId: 'admin-2',
        action: ADMIN_VERIFICATION_REJECTED,
        resourceType: 'verification_request',
        resourceId: 'req-1',
        ip: '10.0.0.2',
      });
      expect(entry.context).toMatchObject({
        previousStatus: VerificationStatus.PENDING,
        status: VerificationStatus.REJECTED,
        reason: 'Licence number does not match the registry',
      });
    });

    it('writes no audit entry when Module 01 refuses the decision', async () => {
      identity.rejectVerification.mockRejectedValue(
        new ApiException(ErrorCode.FORBIDDEN, 'self review'),
      );
      await expect(
        command.execute({ actorUserId: 'user-1', requestId: 'req-1', reason: 'x'.repeat(3), ip: null }),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
