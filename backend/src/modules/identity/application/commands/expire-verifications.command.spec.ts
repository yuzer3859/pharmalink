import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import { IdentityEventType } from '../../domain/events';
import { IOrganizationRepository } from '../../domain/repositories/organization.repository';
import { IVerificationRepository } from '../../domain/repositories/verification.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { ExpireVerificationsCommand } from './expire-verifications.command';
import { SuspendUserCommand } from './suspend-user.command';

const EXPIRES_AT = new Date('2026-01-01T00:00:00.000Z');

function approvedRequest(
  id: string,
  userId: string,
  type: VerificationType = VerificationType.DOCTOR_LICENSE,
): VerificationRequest {
  return VerificationRequest.rehydrate({
    id,
    userId,
    organizationId: type === VerificationType.PHARMACY_LICENSE ? 'org-1' : null,
    type,
    status: VerificationStatus.APPROVED,
    faydaIdEncrypted: null,
    documents: [],
    reviewerId: 'admin-1',
    rejectReason: null,
    submittedAt: new Date('2025-01-01T00:00:00.000Z'),
    reviewedAt: new Date('2025-01-02T00:00:00.000Z'),
    expiresAt: EXPIRES_AT,
    licenseNumber: type === VerificationType.PHARMACY_LICENSE ? 'LIC-1' : null,
  });
}

describe('ExpireVerificationsCommand', () => {
  let verifications: jest.Mocked<IVerificationRepository>;
  let organizations: jest.Mocked<IOrganizationRepository>;
  let uow: jest.Mocked<IUnitOfWork>;
  let suspendUser: jest.Mocked<SuspendUserCommand>;
  let outbox: jest.Mocked<OutboxService>;
  let audit: jest.Mocked<AuditService>;
  let command: ExpireVerificationsCommand;

  beforeEach(() => {
    verifications = {
      listExpired: jest.fn().mockResolvedValue([approvedRequest('req-1', 'user-1')]),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IVerificationRepository>;
    organizations = {
      suspendForExpiredLicense: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<IOrganizationRepository>;
    uow = { run: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) } as unknown as jest.Mocked<IUnitOfWork>;
    suspendUser = { execute: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<SuspendUserCommand>;
    outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<OutboxService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new ExpireVerificationsCommand(verifications, organizations, uow, suspendUser, outbox, audit);
  });

  it('expires a provider licence, emits the event and suspends the provider as the system actor', async () => {
    const processed = await command.execute(new Date('2026-06-01T00:00:00.000Z'));

    expect(processed).toBe(1);
    const saved = (verifications.save.mock.calls[0][0] as VerificationRequest).toProps();
    expect(saved.status).toBe(VerificationStatus.EXPIRED);
    expect(outbox.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: IdentityEventType.LicenseExpired }),
    );
    expect(suspendUser.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: 'user-1',
        actorUserId: null,
        reason: 'LICENSE_EXPIRED:DOCTOR_LICENSE',
      }),
    );
  });

  it('keeps sweeping when one suspension is refused', async () => {
    verifications.listExpired.mockResolvedValue([
      approvedRequest('req-1', 'user-1'),
      approvedRequest('req-2', 'user-2'),
    ]);
    suspendUser.execute.mockRejectedValueOnce(new Error('account deleted'));

    const processed = await command.execute();

    expect(processed).toBe(2);
    expect(verifications.save).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity.license.expiry_suspend_skipped' }),
    );
  });

  it('does nothing when no licence has expired', async () => {
    verifications.listExpired.mockResolvedValue([]);

    expect(await command.execute()).toBe(0);
    expect(suspendUser.execute).not.toHaveBeenCalled();
  });

  describe('PHARMACY_LICENSE (Work 67)', () => {
    beforeEach(() => {
      verifications.listExpired.mockResolvedValue([
        approvedRequest('req-1', 'user-1', VerificationType.PHARMACY_LICENSE),
      ]);
    });

    it('suspends the organisation whose current licence it is, never the owner account', async () => {
      const now = new Date('2026-06-01T00:00:00.000Z');
      expect(await command.execute(now)).toBe(1);

      expect(uow.run).toHaveBeenCalledWith(expect.any(Function), { isolation: 'serializable' });
      const [saved, expectation, tx] = verifications.save.mock.calls[0];
      expect(saved.toProps().status).toBe(VerificationStatus.EXPIRED);
      expect(expectation).toEqual({ status: VerificationStatus.APPROVED });
      expect(tx).toBe('tx');
      expect(organizations.suspendForExpiredLicense).toHaveBeenCalledWith(
        { organizationId: 'org-1', licenseNumber: 'LIC-1', licenseExpiresAt: EXPIRES_AT, now },
        'tx',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'identity.organization.suspended_license_expired', resourceId: 'org-1' }),
        'tx',
      );
      expect(outbox.write).toHaveBeenCalledWith(
        expect.objectContaining({ type: IdentityEventType.LicenseExpired }),
        'tx',
      );
      expect(suspendUser.execute).not.toHaveBeenCalled();
    });

    it('expires a superseded licence without suspending the organisation', async () => {
      organizations.suspendForExpiredLicense.mockResolvedValue(false);
      expect(await command.execute()).toBe(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'identity.license.expired_without_suspension', resourceId: 'req-1' }),
        'tx',
      );
      expect(suspendUser.execute).not.toHaveBeenCalled();
    });

    it('skips a request a concurrent sweep already expired', async () => {
      verifications.save.mockRejectedValue(new ApiException(ErrorCode.BUSINESS_RULE_VIOLATION, 'closed'));
      expect(await command.execute()).toBe(0);
      expect(organizations.suspendForExpiredLicense).not.toHaveBeenCalled();
    });
  });
});
