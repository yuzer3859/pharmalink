import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import { IdentityEventType } from '../../domain/events';
import { IVerificationRepository } from '../../domain/repositories/verification.repository';
import { ExpireVerificationsCommand } from './expire-verifications.command';
import { SuspendUserCommand } from './suspend-user.command';

function approvedRequest(id: string, userId: string): VerificationRequest {
  return VerificationRequest.rehydrate({
    id,
    userId,
    organizationId: 'org-1',
    type: VerificationType.PHARMACY_LICENSE,
    status: VerificationStatus.APPROVED,
    faydaIdEncrypted: null,
    documents: [],
    reviewerId: 'admin-1',
    rejectReason: null,
    submittedAt: new Date('2025-01-01T00:00:00.000Z'),
    reviewedAt: new Date('2025-01-02T00:00:00.000Z'),
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

describe('ExpireVerificationsCommand', () => {
  let verifications: jest.Mocked<IVerificationRepository>;
  let suspendUser: jest.Mocked<SuspendUserCommand>;
  let outbox: jest.Mocked<OutboxService>;
  let audit: jest.Mocked<AuditService>;
  let command: ExpireVerificationsCommand;

  beforeEach(() => {
    verifications = {
      listExpired: jest.fn().mockResolvedValue([approvedRequest('req-1', 'user-1')]),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IVerificationRepository>;
    suspendUser = { execute: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<SuspendUserCommand>;
    outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<OutboxService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new ExpireVerificationsCommand(verifications, suspendUser, outbox, audit);
  });

  it('expires the licence, emits the event and suspends the provider as the system actor', async () => {
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
        reason: 'LICENSE_EXPIRED:PHARMACY_LICENSE',
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
});
