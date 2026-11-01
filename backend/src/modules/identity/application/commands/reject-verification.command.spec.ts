import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { User } from '../../domain/entities/user.entity';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import { IdentityEventType } from '../../domain/events';
import {
  IOrganizationRepository,
  OrganizationRecord,
} from '../../domain/repositories/organization.repository';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IVerificationRepository } from '../../domain/repositories/verification.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { RejectVerificationCommand } from './reject-verification.command';

function request(type = VerificationType.PHARMACY_LICENSE, organizationId: string | null = 'org-1'): VerificationRequest {
  return VerificationRequest.rehydrate({
    id: 'req-1',
    userId: 'user-1',
    organizationId,
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

function org(overrides: Partial<OrganizationRecord> = {}): OrganizationRecord {
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

describe('RejectVerificationCommand', () => {
  let verifications: jest.Mocked<IVerificationRepository>;
  let users: jest.Mocked<IUserRepository>;
  let organizations: jest.Mocked<IOrganizationRepository>;
  let uow: jest.Mocked<IUnitOfWork>;
  let outbox: jest.Mocked<OutboxService>;
  let audit: jest.Mocked<AuditService>;
  let command: RejectVerificationCommand;
  let user: { rejectProviderAccess: jest.Mock };

  beforeEach(() => {
    user = { rejectProviderAccess: jest.fn() };
    verifications = {
      findById: jest.fn().mockResolvedValue(request()),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IVerificationRepository>;
    users = {
      findById: jest.fn().mockResolvedValue(user as unknown as User),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IUserRepository>;
    organizations = {
      findById: jest.fn().mockResolvedValue(org()),
      rejectPendingApplication: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<IOrganizationRepository>;
    uow = { run: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) } as unknown as jest.Mocked<IUnitOfWork>;
    outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<OutboxService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new RejectVerificationCommand(verifications, users, organizations, uow, outbox, audit);
  });

  const reject = () => command.execute({ requestId: 'req-1', reviewerId: 'admin-1', reason: 'Licence photo is unreadable' });

  it('rejects an initial pharmacy application and its pending organisation together', async () => {
    await reject();

    expect(uow.run).toHaveBeenCalledWith(expect.any(Function), { isolation: 'serializable' });
    const [saved, expectation, tx] = verifications.save.mock.calls[0];
    expect(saved.toProps()).toMatchObject({ status: VerificationStatus.REJECTED, rejectReason: 'Licence photo is unreadable' });
    expect(expectation).toEqual({ status: VerificationStatus.PENDING });
    expect(tx).toBe('tx');
    expect(organizations.rejectPendingApplication).toHaveBeenCalledWith('org-1', 'tx');
    expect(outbox.write).toHaveBeenCalledWith(expect.objectContaining({ type: IdentityEventType.ProviderRejected }), 'tx');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity.organization.application_rejected' }),
      'tx',
    );
    expect(user.rejectProviderAccess).toHaveBeenCalled();
  });

  it('leaves a renewing organisation’s status and licence alone', async () => {
    organizations.findById.mockResolvedValue(
      org({ status: 'ACTIVE', licenseNumber: 'LIC-OLD', licenseExpiresAt: new Date(Date.now() + 86_400_000) }),
    );
    organizations.rejectPendingApplication.mockResolvedValue(false);

    await reject();

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.verification.rejected' }), 'tx');
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity.organization.application_rejected' }),
      expect.anything(),
    );
  });

  it.each<[string, () => void, string]>([
    ['without an organisation', () => verifications.findById.mockResolvedValue(request(VerificationType.PHARMACY_LICENSE, null)), 'ORGANIZATION_MISSING'],
    ['for another owner’s organisation', () => organizations.findById.mockResolvedValue(org({ ownerUserId: 'other' })), 'OWNER_MISMATCH'],
    ['for a clinic', () => organizations.findById.mockResolvedValue(org({ type: 'CLINIC' })), 'ORGANIZATION_NOT_PHARMACY'],
  ])('refuses a pharmacy licence request %s', async (_label, arrange, reason) => {
    arrange();
    await expect(reject()).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION, details: { reason } });
    expect(verifications.save).not.toHaveBeenCalled();
    expect(uow.run).not.toHaveBeenCalled();
  });

  it('keeps the existing behaviour for FAYDA and other provider types', async () => {
    verifications.findById.mockResolvedValue(request(VerificationType.FAYDA, null));
    await reject();
    expect(verifications.save).toHaveBeenCalledWith(expect.anything(), { status: VerificationStatus.PENDING });
    expect(users.findById).not.toHaveBeenCalled();
    expect(organizations.findById).not.toHaveBeenCalled();

    verifications.findById.mockResolvedValue(request(VerificationType.DRIVER_DOCS, null));
    await reject();
    expect(user.rejectProviderAccess).toHaveBeenCalled();
    expect(uow.run).not.toHaveBeenCalled();
  });
});
