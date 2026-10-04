import { IPrescriptionRepository, PrescriptionSnapshot } from '../../domain/repositories/prescription.repository';
import { ListPrescriptionsQuery } from './list-prescriptions.query';

function prescriptionSnapshot(overrides: Partial<PrescriptionSnapshot> = {}): PrescriptionSnapshot {
  return {
    id: 'prescription-1',
    customerUserId: 'customer-1',
    beneficiaryId: null,
    status: 'APPROVED',
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
  const prescriptions: jest.Mocked<IPrescriptionRepository> = {
    findById: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    listByCustomer: jest.fn().mockResolvedValue({ items: [prescriptionSnapshot()], total: 1 }),
    listVerificationQueue: jest.fn(),
    findLineById: jest.fn(),
    findLinesByPrescriptionId: jest.fn(),
    createApprovedLines: jest.fn(),
    updateLineDispenseState: jest.fn(),
    logAccess: jest.fn(),
  };
  const query = new ListPrescriptionsQuery(prescriptions);
  return { query, prescriptions };
}

describe('ListPrescriptionsQuery', () => {
  it('delegates to listByCustomer and attaches displayStatus per item', async () => {
    const { query, prescriptions } = build();
    const result = await query.execute({ customerUserId: 'customer-1', page: 1, size: 10 });
    expect(prescriptions.listByCustomer).toHaveBeenCalledWith({
      customerUserId: 'customer-1',
      status: undefined,
      page: 1,
      size: 10,
    });
    expect(result.total).toBe(1);
    expect(result.items[0].displayStatus).toBe('APPROVED');
  });

  it('passes an optional status filter through', async () => {
    const { query, prescriptions } = build();
    await query.execute({ customerUserId: 'customer-1', status: 'APPROVED', page: 1, size: 10 });
    expect(prescriptions.listByCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'APPROVED' }),
    );
  });

  it('marks a past-expiry, non-terminal item as displayStatus=EXPIRED', async () => {
    const { query, prescriptions } = build();
    prescriptions.listByCustomer.mockResolvedValue({
      items: [prescriptionSnapshot({ status: 'APPROVED', expiryDate: new Date(Date.now() - 1000) })],
      total: 1,
    });
    const result = await query.execute({ customerUserId: 'customer-1', page: 1, size: 10 });
    expect(result.items[0].displayStatus).toBe('EXPIRED');
  });
});
