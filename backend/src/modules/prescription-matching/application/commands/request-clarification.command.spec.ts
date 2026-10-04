import { AuditService } from '../../../../shared/audit/audit.service';
import {
  IPrescriptionRepository,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import { IVerificationRepository, VerificationReviewSnapshot } from '../../domain/repositories/verification.repository';
import { IIdentityPort } from '../ports/outbound/identity.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { RequestClarificationCommand } from './request-clarification.command';

function prescriptionSnapshot(overrides: Partial<PrescriptionSnapshot> = {}): PrescriptionSnapshot {
  return {
    id: 'prescription-1',
    customerUserId: 'customer-1',
    beneficiaryId: null,
    status: 'PENDING_VERIFICATION',
    fileRef: null,
    encryptionKeyRef: null,
    fileType: null,
    doctorName: null,
    hospitalName: null,
    issueDate: null,
    expiryDate: null,
    verifiedByUserId: null,
    verifiedAt: null,
    verifyingPharmacyId: 'pharmacy-1',
    rejectionReason: null,
    retentionUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function build() {
  const prescription = prescriptionSnapshot();
  const prescriptions: jest.Mocked<IPrescriptionRepository> = {
    findById: jest.fn().mockResolvedValue(prescription),
    create: jest.fn(),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    listByCustomer: jest.fn(),
    listVerificationQueue: jest.fn(),
    findLineById: jest.fn(),
    findLinesByPrescriptionId: jest.fn(),
    createApprovedLines: jest.fn(),
    updateLineDispenseState: jest.fn(),
    logAccess: jest.fn(),
  };
  const verifications: jest.Mocked<IVerificationRepository> = {
    create: jest.fn().mockResolvedValue({} as VerificationReviewSnapshot),
    listByPrescriptionId: jest.fn(),
  };
  const identity: jest.Mocked<IIdentityPort> = {
    getUserOrganizationIds: jest.fn(),
    hasRoleAtOrganization: jest.fn().mockResolvedValue(true),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;

  const command = new RequestClarificationCommand(prescriptions, verifications, identity, uow, audit);
  return { command, prescriptions, verifications, identity, audit };
}

function clarifyInput(overrides: Record<string, unknown> = {}) {
  return {
    prescriptionId: 'prescription-1',
    reviewerUserId: 'pharmacist-1',
    message: 'Please re-upload a legible copy',
    ...overrides,
  };
}

describe('RequestClarificationCommand', () => {
  it('transitions to CLARIFICATION_REQUESTED and records the review', async () => {
    const { command, prescriptions, verifications, audit } = build();
    await command.execute(clarifyInput());

    expect(prescriptions.updateStatus).toHaveBeenCalledWith(
      'prescription-1',
      { status: 'CLARIFICATION_REQUESTED' },
      undefined,
    );
    expect(verifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'CLARIFICATION', reason: 'Please re-upload a legible copy' }),
      undefined,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRESCRIPTION_CLARIFICATION_REQUESTED' }),
      undefined,
    );
  });

  it('validates message length', async () => {
    const { command } = build();
    await expect(command.execute(clarifyInput({ message: 'ab' }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('404s when the prescription does not exist', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(null);
    await expect(command.execute(clarifyInput())).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  });

  it('409s when the prescription is not PENDING_VERIFICATION', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(prescriptionSnapshot({ status: 'APPROVED' }));
    await expect(command.execute(clarifyInput())).rejects.toMatchObject({
      code: 'INVALID_PRESCRIPTION_STATE_TRANSITION',
    });
  });

  it('403s when the reviewer lacks PHARMACIST at the verifying pharmacy', async () => {
    const { command, identity } = build();
    identity.hasRoleAtOrganization.mockResolvedValue(false);
    await expect(command.execute(clarifyInput())).rejects.toMatchObject({ code: 'VERIFICATION_FORBIDDEN' });
  });
});
