import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import {
  IOrganizationRepository,
  OrganizationRecord,
} from '../../domain/repositories/organization.repository';
import { IVerificationRepository } from '../../domain/repositories/verification.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { SubmitVerificationDocumentsCommand } from './submit-verification-documents.command';

const DOCS = [{ kind: 'PHARMACY_LICENSE', storageRef: 'enc://verification/lic-1' }];

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

function pending(organizationId: string | null, type = VerificationType.PHARMACY_LICENSE): VerificationRequest {
  return VerificationRequest.rehydrate({
    id: `req-${organizationId ?? 'none'}`,
    userId: 'user-1',
    organizationId,
    type,
    status: VerificationStatus.PENDING,
    faydaIdEncrypted: null,
    documents: [{ kind: 'EARLIER', storageRef: 'enc://verification/earlier' }],
    reviewerId: null,
    rejectReason: null,
    submittedAt: new Date(),
    reviewedAt: null,
    expiresAt: null,
    licenseNumber: null,
  });
}

describe('SubmitVerificationDocumentsCommand', () => {
  let verifications: jest.Mocked<IVerificationRepository>;
  let organizations: jest.Mocked<IOrganizationRepository>;
  let uow: jest.Mocked<IUnitOfWork>;
  let audit: jest.Mocked<AuditService>;
  let command: SubmitVerificationDocumentsCommand;

  beforeEach(() => {
    verifications = {
      findPendingForUser: jest.fn().mockResolvedValue(null),
      findPendingPharmacyLicense: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (data: { organizationId: string | null; type: VerificationType }) =>
        VerificationRequest.rehydrate({ ...pending(data.organizationId, data.type).toProps(), documents: [] }),
      ),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IVerificationRepository>;
    organizations = { findById: jest.fn().mockResolvedValue(org()) } as unknown as jest.Mocked<IOrganizationRepository>;
    uow = { run: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) } as unknown as jest.Mocked<IUnitOfWork>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new SubmitVerificationDocumentsCommand(verifications, organizations, uow, audit);
  });

  const submit = (overrides: Record<string, unknown> = {}) =>
    command.execute({
      userId: 'user-1',
      type: VerificationType.PHARMACY_LICENSE,
      organizationId: 'org-1',
      documents: DOCS,
      ...overrides,
    });

  it('opens a request for the caller’s own pharmacy organisation in a Serializable transaction', async () => {
    const result = await submit();

    expect(uow.run).toHaveBeenCalledWith(expect.any(Function), { isolation: 'serializable' });
    expect(verifications.findPendingPharmacyLicense).toHaveBeenCalledWith('user-1', 'org-1', 'tx');
    expect(verifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', organizationId: 'org-1', type: VerificationType.PHARMACY_LICENSE }),
      'tx',
    );
    expect(result).toEqual({ requestId: 'req-org-1', status: 'PENDING', documentCount: 1 });
    expect(verifications.findPendingForUser).not.toHaveBeenCalled();
  });

  it('appends to the open request of the same organisation only', async () => {
    verifications.findPendingPharmacyLicense.mockResolvedValue(pending('org-1'));
    const result = await submit();
    expect(verifications.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ requestId: 'req-org-1', documentCount: 2 });
  });

  it('requires organizationId', async () => {
    await expect(submit({ organizationId: null })).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(uow.run).not.toHaveBeenCalled();
  });

  it.each([
    ['another owner’s organisation', org({ ownerUserId: 'someone-else' })],
    ['a deleted organisation', org({ deletedAt: new Date() })],
    ['an unknown organisation', null],
  ])('answers not found for %s', async (_label, record) => {
    organizations.findById.mockResolvedValue(record);
    await expect(submit()).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(uow.run).not.toHaveBeenCalled();
  });

  it.each(['HOSPITAL', 'CLINIC', 'LAB'])('refuses a pharmacy licence for the caller’s own %s', async (type) => {
    organizations.findById.mockResolvedValue(org({ type }));
    await expect(submit()).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION });
    expect(uow.run).not.toHaveBeenCalled();
  });

  it('runs once more when a concurrent submission opened the request first', async () => {
    uow.run
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockImplementationOnce(async (work: (tx: unknown) => Promise<unknown>) => work('tx'));
    verifications.findPendingPharmacyLicense.mockResolvedValue(pending('org-1'));
    await expect(submit()).resolves.toMatchObject({ requestId: 'req-org-1', documentCount: 2 });
    expect(uow.run).toHaveBeenCalledTimes(2);
  });

  it('retries write conflicts for a few rounds, then gives up loudly', async () => {
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    uow.run.mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict);
    await expect(submit()).resolves.toMatchObject({ documentCount: 1 });
    expect(uow.run).toHaveBeenCalledTimes(3);

    uow.run.mockReset();
    uow.run.mockRejectedValue(conflict);
    await expect(submit()).rejects.toBe(conflict);
    expect(uow.run).toHaveBeenCalledTimes(5);

    uow.run.mockReset();
    uow.run.mockRejectedValue(new Error('database down'));
    await expect(submit()).rejects.toThrow('database down');
    expect(uow.run).toHaveBeenCalledTimes(1);
  });

  it('keeps the per-(user, type) behaviour for other verification types', async () => {
    verifications.findPendingForUser.mockResolvedValue(pending(null, VerificationType.DRIVER_DOCS));
    const result = await submit({ type: VerificationType.DRIVER_DOCS, organizationId: null });
    expect(verifications.findPendingForUser).toHaveBeenCalledWith('user-1', VerificationType.DRIVER_DOCS);
    expect(organizations.findById).not.toHaveBeenCalled();
    expect(uow.run).not.toHaveBeenCalled();
    expect(result.documentCount).toBe(2);
  });
});
