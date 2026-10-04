import { AuditService } from '../../../../shared/audit/audit.service';
import { IConfigPort } from '../../../../shared/config/config.port';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { PrescriptionSnapshot, IPrescriptionRepository } from '../../domain/repositories/prescription.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { UploadPrescriptionCommand } from './upload-prescription.command';

function snapshot(overrides: Partial<PrescriptionSnapshot> = {}): PrescriptionSnapshot {
  return {
    id: 'prescription-1',
    customerUserId: 'customer-1',
    beneficiaryId: null,
    status: 'UPLOADED',
    fileRef: 'file-ref-1',
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

function build() {
  const prescriptions: jest.Mocked<IPrescriptionRepository> = {
    findById: jest.fn(),
    create: jest.fn().mockResolvedValue(snapshot()),
    updateStatus: jest.fn(),
    listByCustomer: jest.fn(),
    listVerificationQueue: jest.fn(),
    findLineById: jest.fn(),
    findLinesByPrescriptionId: jest.fn(),
    createApprovedLines: jest.fn(),
    updateLineDispenseState: jest.fn(),
    logAccess: jest.fn(),
  };
  const config: jest.Mocked<IConfigPort> = {
    get: jest.fn().mockReturnValue(undefined),
    getOrThrow: jest.fn(),
    isFeatureEnabled: jest.fn(),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new UploadPrescriptionCommand(prescriptions, config, uow, audit, outbox);
  return { command, prescriptions, config, audit, outbox };
}

describe('UploadPrescriptionCommand', () => {
  it('creates a prescription with a computed retentionUntil', async () => {
    const { command, prescriptions } = build();
    await command.execute({
      customerUserId: 'customer-1',
      fileRef: 'file-ref-1',
      fileType: 'application/pdf',
    });

    expect(prescriptions.create).toHaveBeenCalledTimes(1);
    const data = prescriptions.create.mock.calls[0][0];
    expect(data.customerUserId).toBe('customer-1');
    expect(data.retentionUntil).toBeInstanceOf(Date);
    expect((data.retentionUntil as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects expiryDate before issueDate (§5.1 business validation)', async () => {
    const { command } = build();
    await expect(
      command.execute({
        customerUserId: 'customer-1',
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
        issueDate: new Date('2026-02-01'),
        expiryDate: new Date('2026-01-01'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('writes an audit entry and a PrescriptionUploaded event', async () => {
    const { command, audit, outbox } = build();
    await command.execute({
      customerUserId: 'customer-1',
      fileRef: 'file-ref-1',
      fileType: 'application/pdf',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRESCRIPTION_UPLOADED', resourceType: 'Prescription' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('uses the configured retention period when set', async () => {
    const { command, config, prescriptions } = build();
    config.get.mockReturnValue(1);
    await command.execute({
      customerUserId: 'customer-1',
      fileRef: 'file-ref-1',
      fileType: 'application/pdf',
    });
    const data = prescriptions.create.mock.calls[0][0];
    const retentionUntil = data.retentionUntil as Date;
    const oneYearFromNow = new Date();
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
    expect(Math.abs(retentionUntil.getTime() - oneYearFromNow.getTime())).toBeLessThan(5000);
  });
});
