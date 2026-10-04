import { IPrescriptionRepository, PrescriptionSnapshot } from '../../domain/repositories/prescription.repository';
import { IIdentityPort } from '../ports/outbound/identity.port';
import { GetPrescriptionQuery } from './get-prescription.query';

function prescriptionSnapshot(overrides: Partial<PrescriptionSnapshot> = {}): PrescriptionSnapshot {
  return {
    id: 'prescription-1',
    customerUserId: 'customer-1',
    beneficiaryId: null,
    status: 'APPROVED',
    fileRef: 'file-ref-1',
    encryptionKeyRef: null,
    fileType: null,
    doctorName: null,
    hospitalName: null,
    issueDate: null,
    expiryDate: null,
    verifiedByUserId: 'pharmacist-1',
    verifiedAt: new Date(),
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
    updateStatus: jest.fn(),
    listByCustomer: jest.fn(),
    listVerificationQueue: jest.fn(),
    findLineById: jest.fn(),
    findLinesByPrescriptionId: jest.fn(),
    createApprovedLines: jest.fn(),
    updateLineDispenseState: jest.fn(),
    logAccess: jest.fn().mockResolvedValue(undefined),
  };
  const identity: jest.Mocked<IIdentityPort> = {
    getUserOrganizationIds: jest.fn(),
    hasRoleAtOrganization: jest.fn().mockResolvedValue(false),
  };

  const query = new GetPrescriptionQuery(prescriptions, identity);
  return { query, prescriptions, identity };
}

describe('GetPrescriptionQuery', () => {
  it('allows and logs ALLOW for the owning customer', async () => {
    const { query, prescriptions } = build();
    const result = await query.execute({
      prescriptionId: 'prescription-1',
      requestingUserId: 'customer-1',
    });
    expect(result.id).toBe('prescription-1');
    expect(prescriptions.logAccess).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'ALLOW', role: 'CUSTOMER' }),
    );
  });

  it('allows and logs ALLOW for a reviewing pharmacist at the verifying pharmacy', async () => {
    const { query, identity, prescriptions } = build();
    identity.hasRoleAtOrganization.mockResolvedValue(true);
    const result = await query.execute({
      prescriptionId: 'prescription-1',
      requestingUserId: 'pharmacist-1',
    });
    expect(result.id).toBe('prescription-1');
    expect(prescriptions.logAccess).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'ALLOW', role: 'PHARMACIST' }),
    );
  });

  it('allows an admin regardless of ownership', async () => {
    const { query } = build();
    await expect(
      query.execute({ prescriptionId: 'prescription-1', requestingUserId: 'admin-1', isAdmin: true }),
    ).resolves.toBeDefined();
  });

  it('denies and logs DENY for an unrelated user, without leaking existence (generic 404)', async () => {
    const { query, prescriptions } = build();
    await expect(
      query.execute({ prescriptionId: 'prescription-1', requestingUserId: 'stranger-1' }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
    expect(prescriptions.logAccess).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'DENY', role: null }),
    );
  });

  it('404s for a truly nonexistent prescription without writing an access-log row', async () => {
    const { query, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(null);
    await expect(
      query.execute({ prescriptionId: 'unknown', requestingUserId: 'customer-1' }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
    expect(prescriptions.logAccess).not.toHaveBeenCalled();
  });

  it('computes displayStatus=EXPIRED for a past-expiry, non-terminal prescription (§20 Decision 5)', async () => {
    const { query, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(
      prescriptionSnapshot({ status: 'APPROVED', expiryDate: new Date(Date.now() - 1000) }),
    );
    const result = await query.execute({ prescriptionId: 'prescription-1', requestingUserId: 'customer-1' });
    expect(result.displayStatus).toBe('EXPIRED');
    expect(result.status).toBe('APPROVED'); // stored status column itself is untouched
  });

  it('does not override displayStatus for an already-terminal status even if past expiry', async () => {
    const { query, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(
      prescriptionSnapshot({ status: 'CONSUMED', expiryDate: new Date(Date.now() - 1000) }),
    );
    const result = await query.execute({ prescriptionId: 'prescription-1', requestingUserId: 'customer-1' });
    expect(result.displayStatus).toBe('CONSUMED');
  });
});
