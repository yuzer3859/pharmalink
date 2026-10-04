import { AuditService } from '../../../../shared/audit/audit.service';
import { IEncryptionPort } from '../../../../shared/crypto/crypto.port';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { User } from '../../domain/entities/user.entity';
import {
  AccountStatus,
  PreferredLanguage,
  PrimaryRole,
  VerificationStatus,
  VerificationType,
} from '../../domain/enums';
import {
  IConsentRepository,
  IVerificationRepository,
} from '../../domain/repositories/verification.repository';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IIdentityVerificationProvider } from '../ports/identity-verification.provider';
import { SubmitFaydaVerificationCommand } from './submit-fayda-verification.command';

function fakeUser(): User {
  return User.rehydrate({
    id: 'user-1',
    phone: '+251911000000',
    email: null,
    passwordHash: 'hash',
    primaryRole: PrimaryRole.PHARMACY_OWNER,
    status: AccountStatus.PENDING_APPROVAL,
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

function fakeRequest(): VerificationRequest {
  return VerificationRequest.rehydrate({
    id: 'req-1',
    userId: 'user-1',
    organizationId: null,
    type: VerificationType.FAYDA,
    status: VerificationStatus.PENDING,
    faydaIdEncrypted: 'enc',
    documents: [],
    reviewerId: null,
    rejectReason: null,
    submittedAt: new Date(),
    reviewedAt: null,
    expiresAt: null,
  });
}

describe('SubmitFaydaVerificationCommand', () => {
  let verifications: jest.Mocked<IVerificationRepository>;
  let consents: jest.Mocked<IConsentRepository>;
  let users: jest.Mocked<IUserRepository>;
  let provider: jest.Mocked<IIdentityVerificationProvider>;
  let encryption: jest.Mocked<IEncryptionPort>;
  let audit: jest.Mocked<AuditService>;
  let command: SubmitFaydaVerificationCommand;

  const validInput = {
    userId: 'user-1',
    faydaId: '123456789012',
    consentGranted: true,
  };

  beforeEach(() => {
    verifications = {
      findPendingForUser: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(fakeRequest()),
    } as unknown as jest.Mocked<IVerificationRepository>;
    consents = { record: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<IConsentRepository>;
    users = { findById: jest.fn().mockResolvedValue(fakeUser()) } as unknown as jest.Mocked<IUserRepository>;
    provider = {
      verifyFayda: jest.fn().mockResolvedValue({ matched: true, providerReference: 'MOCK-9012' }),
    } as unknown as jest.Mocked<IIdentityVerificationProvider>;
    encryption = {
      encryptToString: jest.fn().mockReturnValue('encrypted-blob'),
    } as unknown as jest.Mocked<IEncryptionPort>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;

    command = new SubmitFaydaVerificationCommand(
      verifications,
      consents,
      users,
      provider,
      encryption,
      audit,
    );
  });

  it('encrypts the Fayda id and opens a pending request', async () => {
    const result = await command.execute(validInput);

    expect(encryption.encryptToString).toHaveBeenCalledWith('123456789012');
    expect(verifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: VerificationType.FAYDA, faydaIdEncrypted: 'encrypted-blob' }),
    );
    expect(result).toEqual({ requestId: 'req-1', status: VerificationStatus.PENDING });
  });

  it('never persists the plaintext Fayda id', async () => {
    await command.execute(validInput);

    const created = verifications.create.mock.calls[0][0];
    expect(JSON.stringify(created)).not.toContain('123456789012');
  });

  it('records the consent decision', async () => {
    await command.execute(validInput);

    expect(consents.record).toHaveBeenCalledWith('user-1', 'DATA_PROCESSING', true, 'FAYDA_V1');
  });

  it('refuses submission without consent', async () => {
    await expect(
      command.execute({ ...validInput, consentGranted: false }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(provider.verifyFayda).not.toHaveBeenCalled();
  });

  it('rejects a failed provider match and audits it without creating a request', async () => {
    provider.verifyFayda.mockResolvedValue({ matched: false, failureReason: 'No match found.' });

    await expect(command.execute(validInput)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(verifications.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity.verification.fayda_match_failed' }),
    );
  });

  it('refuses a second submission while one is pending', async () => {
    verifications.findPendingForUser.mockResolvedValue(fakeRequest());

    await expect(command.execute(validInput)).rejects.toMatchObject({
      code: ErrorCode.VERIFICATION_PENDING,
    });
  });
});
