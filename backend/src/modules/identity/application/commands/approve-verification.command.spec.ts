import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { User } from '../../domain/entities/user.entity';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import {
  AccountStatus,
  PreferredLanguage,
  PrimaryRole,
  VerificationStatus,
  VerificationType,
} from '../../domain/enums';
import { IdentityEventType } from '../../domain/events';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IVerificationRepository } from '../../domain/repositories/verification.repository';
import { ApproveVerificationCommand } from './approve-verification.command';

function fakeUser(status = AccountStatus.PENDING_APPROVAL): User {
  return User.rehydrate({
    id: 'user-1',
    phone: '+251911000000',
    email: null,
    passwordHash: 'hash',
    primaryRole: PrimaryRole.PHARMACY_OWNER,
    status,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: new Date(),
    emailVerifiedAt: null,
    faydaVerifiedAt: null,
    guardianId: null,
    permVersion: 1,
    deletionRequestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
}

function fakeRequest(type = VerificationType.PHARMACY_LICENSE): VerificationRequest {
  return VerificationRequest.rehydrate({
    id: 'req-1',
    userId: 'user-1',
    organizationId: 'org-1',
    type,
    status: VerificationStatus.PENDING,
    faydaIdEncrypted: null,
    documents: [],
    reviewerId: null,
    rejectReason: null,
    submittedAt: new Date(),
    reviewedAt: null,
    expiresAt: null,
  });
}

describe('ApproveVerificationCommand', () => {
  let verifications: jest.Mocked<IVerificationRepository>;
  let users: jest.Mocked<IUserRepository>;
  let outbox: jest.Mocked<OutboxService>;
  let audit: jest.Mocked<AuditService>;
  let command: ApproveVerificationCommand;

  beforeEach(() => {
    verifications = {
      findById: jest.fn().mockResolvedValue(fakeRequest()),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IVerificationRepository>;
    users = {
      findById: jest.fn().mockResolvedValue(fakeUser()),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IUserRepository>;
    outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<OutboxService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new ApproveVerificationCommand(verifications, users, outbox, audit);
  });

  it('activates a pending-approval provider and emits ProviderApproved', async () => {
    const expiry = new Date('2027-01-01T00:00:00.000Z');

    await command.execute({ requestId: 'req-1', reviewerId: 'admin-1', expiresAt: expiry });

    const savedRequest = (verifications.save.mock.calls[0][0] as VerificationRequest).toProps();
    expect(savedRequest.status).toBe(VerificationStatus.APPROVED);
    expect(savedRequest.expiresAt).toEqual(expiry);

    const savedUser = (users.save.mock.calls[0][0] as User).toProps();
    expect(savedUser.status).toBe(AccountStatus.ACTIVE);

    expect(outbox.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: IdentityEventType.ProviderApproved }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity.verification.approved' }),
    );
  });

  it('sets the Fayda flag and emits UserVerified for a FAYDA request', async () => {
    verifications.findById.mockResolvedValue(fakeRequest(VerificationType.FAYDA));

    await command.execute({ requestId: 'req-1', reviewerId: 'admin-1' });

    const savedUser = (users.save.mock.calls[0][0] as User).toProps();
    expect(savedUser.faydaVerifiedAt).not.toBeNull();
    expect(savedUser.status).toBe(AccountStatus.PENDING_APPROVAL);
    expect(outbox.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: IdentityEventType.UserVerified }),
    );
  });

  it('enforces separation of duties', async () => {
    await expect(
      command.execute({ requestId: 'req-1', reviewerId: 'user-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    expect(verifications.save).not.toHaveBeenCalled();
    expect(users.save).not.toHaveBeenCalled();
  });

  it('404s for an unknown request', async () => {
    verifications.findById.mockResolvedValue(null);

    await expect(
      command.execute({ requestId: 'missing', reviewerId: 'admin-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
