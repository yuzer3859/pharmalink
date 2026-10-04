import { AuditService } from '../../../../shared/audit/audit.service';
import {
  IPrescriptionRepository,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { AssignVerifyingPharmacyCommand } from './assign-verifying-pharmacy.command';

function prescriptionSnapshot(overrides: Partial<PrescriptionSnapshot> = {}): PrescriptionSnapshot {
  return {
    id: 'prescription-1',
    customerUserId: 'customer-1',
    beneficiaryId: null,
    status: 'UPLOADED',
    fileRef: null,
    encryptionKeyRef: null,
    fileType: null,
    doctorName: null,
    hospitalName: null,
    issueDate: null,
    expiryDate: null,
    verifiedByUserId: null,
    verifiedAt: null,
    verifyingPharmacyId: null,
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
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;

  const command = new AssignVerifyingPharmacyCommand(prescriptions, uow, audit);
  return { command, prescriptions, audit };
}

describe('AssignVerifyingPharmacyCommand', () => {
  it('transitions UPLOADED -> PENDING_VERIFICATION and sets verifyingPharmacyId', async () => {
    const { command, prescriptions, audit } = build();
    await command.execute({ prescriptionId: 'prescription-1', pharmacyId: 'pharmacy-1' });

    expect(prescriptions.updateStatus).toHaveBeenCalledWith(
      'prescription-1',
      { status: 'PENDING_VERIFICATION', verifyingPharmacyId: 'pharmacy-1' },
      undefined,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRESCRIPTION_PHARMACY_ASSIGNED' }),
      undefined,
    );
  });

  it('also accepts CLARIFICATION_REQUESTED -> PENDING_VERIFICATION', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(prescriptionSnapshot({ status: 'CLARIFICATION_REQUESTED' }));
    await expect(
      command.execute({ prescriptionId: 'prescription-1', pharmacyId: 'pharmacy-1' }),
    ).resolves.toBeDefined();
  });

  it('404s when the prescription does not exist', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(null);
    await expect(
      command.execute({ prescriptionId: 'prescription-1', pharmacyId: 'pharmacy-1' }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  });

  it('409s for an illegal source status (e.g. already APPROVED)', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(prescriptionSnapshot({ status: 'APPROVED' }));
    await expect(
      command.execute({ prescriptionId: 'prescription-1', pharmacyId: 'pharmacy-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_PRESCRIPTION_STATE_TRANSITION' });
  });
});
