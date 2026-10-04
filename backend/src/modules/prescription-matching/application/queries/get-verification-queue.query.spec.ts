import { IPrescriptionRepository, PrescriptionSnapshot } from '../../domain/repositories/prescription.repository';
import { GetVerificationQueueQuery } from './get-verification-queue.query';

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
  const prescriptions: jest.Mocked<IPrescriptionRepository> = {
    findById: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    listByCustomer: jest.fn(),
    listVerificationQueue: jest.fn().mockResolvedValue({ items: [prescriptionSnapshot()], total: 1 }),
    findLineById: jest.fn(),
    findLinesByPrescriptionId: jest.fn(),
    createApprovedLines: jest.fn(),
    updateLineDispenseState: jest.fn(),
    logAccess: jest.fn(),
  };
  const query = new GetVerificationQueueQuery(prescriptions);
  return { query, prescriptions };
}

describe('GetVerificationQueueQuery', () => {
  it('delegates to listVerificationQueue scoped to the caller pharmacy org', async () => {
    const { query, prescriptions } = build();
    const result = await query.execute({ verifyingPharmacyId: 'pharmacy-1', page: 1, size: 20 });
    expect(prescriptions.listVerificationQueue).toHaveBeenCalledWith({
      verifyingPharmacyId: 'pharmacy-1',
      page: 1,
      size: 20,
    });
    expect(result.total).toBe(1);
  });
});
