import { AuditService } from '../../../../shared/audit/audit.service';
import {
  IPrescriptionRepository,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { ReuploadPrescriptionCommand } from './reupload-prescription.command';

function prescriptionSnapshot(overrides: Partial<PrescriptionSnapshot> = {}): PrescriptionSnapshot {
  return {
    id: 'prescription-1',
    customerUserId: 'customer-1',
    beneficiaryId: null,
    status: 'CLARIFICATION_REQUESTED',
    fileRef: 'old-file-ref',
    encryptionKeyRef: null,
    fileType: 'application/pdf',
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

function build(prescription: PrescriptionSnapshot = prescriptionSnapshot()) {
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

  const command = new ReuploadPrescriptionCommand(prescriptions, uow, audit);
  return { command, prescriptions, audit };
}

describe('ReuploadPrescriptionCommand', () => {
  it('transitions CLARIFICATION_REQUESTED -> UPLOADED when no pharmacy has been assigned yet', async () => {
    const { command, prescriptions, audit } = build();
    await command.execute({
      prescriptionId: 'prescription-1',
      customerUserId: 'customer-1',
      fileRef: 'new-file-ref',
      fileType: 'application/pdf',
    });

    expect(prescriptions.updateStatus).toHaveBeenCalledWith(
      'prescription-1',
      { status: 'UPLOADED', fileRef: 'new-file-ref', encryptionKeyRef: null, fileType: 'application/pdf' },
      undefined,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRESCRIPTION_REUPLOADED' }),
      undefined,
    );
  });

  it('transitions CLARIFICATION_REQUESTED -> PENDING_VERIFICATION when already assigned to a pharmacy', async () => {
    const { command, prescriptions } = build(
      prescriptionSnapshot({ verifyingPharmacyId: 'pharmacy-org-1' }),
    );
    await command.execute({
      prescriptionId: 'prescription-1',
      customerUserId: 'customer-1',
      fileRef: 'new-file-ref',
      fileType: 'application/pdf',
    });

    expect(prescriptions.updateStatus).toHaveBeenCalledWith(
      'prescription-1',
      expect.objectContaining({ status: 'PENDING_VERIFICATION' }),
      undefined,
    );
  });

  it('404s when the prescription does not exist', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(null);
    await expect(
      command.execute({
        prescriptionId: 'prescription-1',
        customerUserId: 'customer-1',
        fileRef: 'new-file-ref',
        fileType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  });

  it('404s (no existence leakage) when a non-owner attempts to reupload', async () => {
    const { command } = build();
    await expect(
      command.execute({
        prescriptionId: 'prescription-1',
        customerUserId: 'stranger-1',
        fileRef: 'new-file-ref',
        fileType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  });

  it('409s for an illegal source status (e.g. still UPLOADED, never clarified)', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(prescriptionSnapshot({ status: 'UPLOADED' }));
    await expect(
      command.execute({
        prescriptionId: 'prescription-1',
        customerUserId: 'customer-1',
        fileRef: 'new-file-ref',
        fileType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PRESCRIPTION_STATE_TRANSITION' });
  });
});
