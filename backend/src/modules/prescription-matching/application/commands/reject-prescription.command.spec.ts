import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  IPrescriptionRepository,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import { IVerificationRepository, VerificationReviewSnapshot } from '../../domain/repositories/verification.repository';
import { IIdentityPort } from '../ports/outbound/identity.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { RejectPrescriptionCommand } from './reject-prescription.command';

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
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new RejectPrescriptionCommand(prescriptions, verifications, identity, uow, audit, outbox);
  return { command, prescriptions, verifications, identity, audit, outbox };
}

function rejectInput(overrides: Record<string, unknown> = {}) {
  return {
    prescriptionId: 'prescription-1',
    reviewerUserId: 'pharmacist-1',
    reason: 'Illegible handwriting',
    ...overrides,
  };
}

describe('RejectPrescriptionCommand', () => {
  it('rejects a PENDING_VERIFICATION prescription with a reason', async () => {
    const { command, prescriptions, verifications, audit, outbox } = build();
    await command.execute(rejectInput());

    expect(prescriptions.updateStatus).toHaveBeenCalledWith(
      'prescription-1',
      { status: 'REJECTED', rejectionReason: 'Illegible handwriting' },
      undefined,
    );
    expect(verifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'REJECTED', reason: 'Illegible handwriting' }),
      undefined,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRESCRIPTION_REJECTED' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('throws REJECTION_REASON_REQUIRED for an empty reason (BRULE-14, checked before any write)', async () => {
    const { command, prescriptions } = build();
    await expect(command.execute(rejectInput({ reason: '' }))).rejects.toMatchObject({
      code: 'REJECTION_REASON_REQUIRED',
    });
    expect(prescriptions.updateStatus).not.toHaveBeenCalled();
  });

  it('throws VALIDATION_ERROR for a too-short reason', async () => {
    const { command } = build();
    await expect(command.execute(rejectInput({ reason: 'ab' }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('404s when the prescription does not exist', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(null);
    await expect(command.execute(rejectInput())).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  });

  it('409s when the prescription is not PENDING_VERIFICATION', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(prescriptionSnapshot({ status: 'REJECTED' }));
    await expect(command.execute(rejectInput())).rejects.toMatchObject({
      code: 'INVALID_PRESCRIPTION_STATE_TRANSITION',
    });
  });

  it('403s when the reviewer lacks PHARMACIST at the verifying pharmacy', async () => {
    const { command, identity } = build();
    identity.hasRoleAtOrganization.mockResolvedValue(false);
    await expect(command.execute(rejectInput())).rejects.toMatchObject({ code: 'VERIFICATION_FORBIDDEN' });
  });
});
