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
import {
  IOrganizationRepository,
  OrganizationRecord,
} from '../../domain/repositories/organization.repository';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IVerificationRepository } from '../../domain/repositories/verification.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
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
    licenseNumber: null,
  });
}

function fakeOrg(overrides: Partial<OrganizationRecord> = {}): OrganizationRecord {
  return {
    id: 'org-1',
    type: 'PHARMACY',
    name: 'Abebe Pharmacy',
    status: 'PENDING_APPROVAL',
    ownerUserId: 'user-1',
    applicationKey: 'key-1',
    licenseNumber: null,
    licenseExpiresAt: null,
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

const FUTURE = new Date(Date.now() + 365 * 24 * 3600 * 1000);

describe('ApproveVerificationCommand', () => {
  let verifications: jest.Mocked<IVerificationRepository>;
  let users: jest.Mocked<IUserRepository>;
  let organizations: jest.Mocked<IOrganizationRepository>;
  let uow: jest.Mocked<IUnitOfWork>;
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
    organizations = {
      findById: jest.fn().mockResolvedValue(fakeOrg()),
      recordApprovedLicense: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<IOrganizationRepository>;
    uow = { run: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) } as unknown as jest.Mocked<IUnitOfWork>;
    outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<OutboxService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new ApproveVerificationCommand(verifications, users, organizations, uow, outbox, audit);
  });

  it('activates a pending-approval provider and emits ProviderApproved (non-pharmacy licence)', async () => {
    verifications.findById.mockResolvedValue(fakeRequest(VerificationType.DRIVER_DOCS));
    const expiry = new Date('2027-01-01T00:00:00.000Z');

    await command.execute({ requestId: 'req-1', reviewerId: 'admin-1', expiresAt: expiry });

    const savedRequest = (verifications.save.mock.calls[0][0] as VerificationRequest).toProps();
    expect(savedRequest.status).toBe(VerificationStatus.APPROVED);
    expect(savedRequest.expiresAt).toEqual(expiry);
    expect(savedRequest.licenseNumber).toBeNull();

    const savedUser = (users.save.mock.calls[0][0] as User).toProps();
    expect(savedUser.status).toBe(AccountStatus.ACTIVE);

    expect(outbox.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: IdentityEventType.ProviderApproved }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity.verification.approved' }),
    );
    expect(organizations.recordApprovedLicense).not.toHaveBeenCalled();
  });

  it('approves DOCTOR_LICENSE and DRIVER_DOCS without pharmacy licence fields', async () => {
    for (const type of [VerificationType.DOCTOR_LICENSE, VerificationType.DRIVER_DOCS]) {
      verifications.findById.mockResolvedValue(fakeRequest(type));
      await expect(command.execute({ requestId: 'req-1', reviewerId: 'admin-1' })).resolves.toBeUndefined();
    }
    expect(organizations.findById).not.toHaveBeenCalled();
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
      command.execute({ requestId: 'req-1', reviewerId: 'user-1', licenseNumber: 'LIC-1', expiresAt: FUTURE }),
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

  describe('PHARMACY_LICENSE (Work 67)', () => {
    it('records the trimmed licence on the request and the organisation in one transaction', async () => {
      await command.execute({
        requestId: 'req-1',
        reviewerId: 'admin-1',
        licenseNumber: '  EFDA/PH/0042  ',
        expiresAt: FUTURE,
      });

      expect(uow.run).toHaveBeenCalledWith(expect.any(Function), { isolation: 'serializable' });
      const [saved, expectation, tx] = verifications.save.mock.calls[0];
      expect(saved.toProps()).toMatchObject({
        status: VerificationStatus.APPROVED,
        licenseNumber: 'EFDA/PH/0042',
        expiresAt: FUTURE,
        reviewerId: 'admin-1',
      });
      expect(expectation).toEqual({ status: VerificationStatus.PENDING });
      expect(tx).toBe('tx');
      expect(organizations.recordApprovedLicense).toHaveBeenCalledWith(
        { organizationId: 'org-1', ownerUserId: 'user-1', licenseNumber: 'EFDA/PH/0042', licenseExpiresAt: FUTURE },
        'tx',
      );
      expect(outbox.write).toHaveBeenCalledWith(
        expect.objectContaining({ type: IdentityEventType.ProviderApproved }),
        'tx',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'identity.organization.license_approved' }),
        'tx',
      );
    });

    it.each([
      ['missing', undefined],
      ['blank', '   '],
      ['too long', 'X'.repeat(65)],
    ])('rejects a %s licence number and changes nothing', async (_label, licenseNumber) => {
      await expect(
        command.execute({ requestId: 'req-1', reviewerId: 'admin-1', licenseNumber, expiresAt: FUTURE }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(uow.run).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', null],
      ['in the past', new Date(Date.now() - 1000)],
      ['invalid', new Date('not a date')],
    ])('rejects a %s expiry and changes nothing', async (_label, expiresAt) => {
      await expect(
        command.execute({ requestId: 'req-1', reviewerId: 'admin-1', licenseNumber: 'LIC-1', expiresAt }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(uow.run).not.toHaveBeenCalled();
    });

    it.each<[string, () => void, string]>([
      [
        'has no organisation',
        () =>
          verifications.findById.mockResolvedValue(
            VerificationRequest.rehydrate({ ...fakeRequest().toProps(), organizationId: null }),
          ),
        'ORGANIZATION_MISSING',
      ],
      ['names a deleted organisation', () => organizations.findById.mockResolvedValue(fakeOrg({ deletedAt: new Date() })), 'ORGANIZATION_NOT_FOUND'],
      ['names an unknown organisation', () => organizations.findById.mockResolvedValue(null), 'ORGANIZATION_NOT_FOUND'],
      ['names a hospital', () => organizations.findById.mockResolvedValue(fakeOrg({ type: 'HOSPITAL' })), 'ORGANIZATION_NOT_PHARMACY'],
      ['names another owner’s organisation', () => organizations.findById.mockResolvedValue(fakeOrg({ ownerUserId: 'someone-else' })), 'OWNER_MISMATCH'],
    ])('refuses a request that %s', async (_label, arrange, reason) => {
      arrange();
      await expect(
        command.execute({ requestId: 'req-1', reviewerId: 'admin-1', licenseNumber: 'LIC-1', expiresAt: FUTURE }),
      ).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION, details: { reason } });
      expect(uow.run).not.toHaveBeenCalled();
      expect(verifications.save).not.toHaveBeenCalled();
    });

    it('rolls back when the organisation changed under the approval', async () => {
      organizations.recordApprovedLicense.mockResolvedValue(false);
      await expect(
        command.execute({ requestId: 'req-1', reviewerId: 'admin-1', licenseNumber: 'LIC-1', expiresAt: FUTURE }),
      ).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION });
      expect(outbox.write).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('propagates a lost compare-and-set before touching the organisation', async () => {
      verifications.save.mockRejectedValue(new Error('closed'));
      await expect(
        command.execute({ requestId: 'req-1', reviewerId: 'admin-1', licenseNumber: 'LIC-1', expiresAt: FUTURE }),
      ).rejects.toThrow('closed');
      expect(organizations.recordApprovedLicense).not.toHaveBeenCalled();
    });
  });
});
