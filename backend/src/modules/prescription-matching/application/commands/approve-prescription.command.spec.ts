import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  IPrescriptionRepository,
  PrescriptionLineSnapshot,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import {
  IVerificationRepository,
  VerificationReviewSnapshot,
} from '../../domain/repositories/verification.repository';
import { ICatalogPort } from '../ports/outbound/catalog.port';
import { IIdentityPort } from '../ports/outbound/identity.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { ApprovePrescriptionCommand } from './approve-prescription.command';

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

function lineSnapshot(overrides: Partial<PrescriptionLineSnapshot> = {}): PrescriptionLineSnapshot {
  return {
    id: 'line-1',
    prescriptionId: 'prescription-1',
    catalogProductId: 'product-1',
    rawText: null,
    prescribedQuantity: 30,
    refillsAllowed: 0,
    dispensedQuantity: 0,
    remainingDispensable: 30,
    isSingleUse: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function reviewSnapshot(overrides: Partial<VerificationReviewSnapshot> = {}): VerificationReviewSnapshot {
  return {
    id: 'review-1',
    prescriptionId: 'prescription-1',
    reviewerUserId: 'pharmacist-1',
    pharmacyId: 'pharmacy-1',
    decision: 'APPROVED',
    reason: null,
    legibilityOk: true,
    validityOk: true,
    reviewedAt: new Date(),
    ...overrides,
  };
}

function build() {
  const prescription = prescriptionSnapshot();
  const createdLine = lineSnapshot();
  const prescriptions: jest.Mocked<IPrescriptionRepository> = {
    findById: jest.fn().mockResolvedValue(prescription),
    create: jest.fn(),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    listByCustomer: jest.fn(),
    listVerificationQueue: jest.fn(),
    findLineById: jest.fn(),
    findLinesByPrescriptionId: jest.fn(),
    createApprovedLines: jest.fn().mockResolvedValue([createdLine]),
    updateLineDispenseState: jest.fn(),
    logAccess: jest.fn(),
  };
  const verifications: jest.Mocked<IVerificationRepository> = {
    create: jest.fn().mockResolvedValue(reviewSnapshot()),
    listByPrescriptionId: jest.fn(),
  };
  const catalog: jest.Mocked<ICatalogPort> = {
    getProduct: jest.fn().mockResolvedValue({ id: 'product-1', status: 'ACTIVE', rxClassification: 'RX' }),
  };
  const identity: jest.Mocked<IIdentityPort> = {
    getUserOrganizationIds: jest.fn(),
    hasRoleAtOrganization: jest.fn().mockResolvedValue(true),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new ApprovePrescriptionCommand(
    prescriptions,
    verifications,
    catalog,
    identity,
    uow,
    audit,
    outbox,
  );
  return { command, prescriptions, verifications, catalog, identity, audit, outbox, prescription };
}

function approveInput(overrides: Record<string, unknown> = {}) {
  return {
    prescriptionId: 'prescription-1',
    reviewerUserId: 'pharmacist-1',
    lines: [
      { catalogProductId: 'product-1', approvedQuantity: 30, refillsAllowed: 0, isSingleUse: false },
    ],
    legibilityOk: true,
    validityOk: true,
    ...overrides,
  };
}

describe('ApprovePrescriptionCommand', () => {
  it('approves a PENDING_VERIFICATION prescription and creates the approved lines', async () => {
    const { command, prescriptions, verifications, audit, outbox } = build();
    await command.execute(approveInput());

    expect(prescriptions.updateStatus).toHaveBeenCalledWith(
      'prescription-1',
      expect.objectContaining({ status: 'APPROVED', verifiedByUserId: 'pharmacist-1' }),
      undefined,
    );
    expect(prescriptions.createApprovedLines).toHaveBeenCalledTimes(1);
    expect(verifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'APPROVED', pharmacyId: 'pharmacy-1' }),
      undefined,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRESCRIPTION_APPROVED' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('404s when the prescription does not exist', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(null);
    await expect(command.execute(approveInput())).rejects.toMatchObject({
      code: 'PRESCRIPTION_NOT_FOUND',
    });
  });

  it('409s when the prescription is not PENDING_VERIFICATION', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(prescriptionSnapshot({ status: 'APPROVED' }));
    await expect(command.execute(approveInput())).rejects.toMatchObject({
      code: 'INVALID_PRESCRIPTION_STATE_TRANSITION',
    });
  });

  it('403s when the reviewer is the uploading customer (self-review guard)', async () => {
    const { command } = build();
    await expect(
      command.execute(approveInput({ reviewerUserId: 'customer-1' })),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FORBIDDEN' });
  });

  it('403s when the reviewer does not hold PHARMACIST at the verifying pharmacy', async () => {
    const { command, identity } = build();
    identity.hasRoleAtOrganization.mockResolvedValue(false);
    await expect(command.execute(approveInput())).rejects.toMatchObject({
      code: 'VERIFICATION_FORBIDDEN',
    });
  });

  it('404s (CATALOG_PRODUCT_NOT_FOUND) when a mapped catalogProductId does not resolve to an ACTIVE product', async () => {
    const { command, catalog } = build();
    catalog.getProduct.mockResolvedValue(null);
    await expect(command.execute(approveInput())).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_NOT_FOUND',
    });
  });

  it('404s (CATALOG_PRODUCT_NOT_FOUND) when the product is not ACTIVE', async () => {
    const { command, catalog } = build();
    catalog.getProduct.mockResolvedValue({ id: 'product-1', status: 'DRAFT', rxClassification: 'RX' });
    await expect(command.execute(approveInput())).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_NOT_FOUND',
    });
  });

  it('re-validates the state transition against the fresh in-transaction read (defends against a race)', async () => {
    const { command, prescriptions } = build();
    // Pre-transaction read says PENDING_VERIFICATION, but the in-transaction re-read has since
    // moved on (e.g. a concurrent reject committed first).
    prescriptions.findById
      .mockResolvedValueOnce(prescriptionSnapshot({ status: 'PENDING_VERIFICATION' }))
      .mockResolvedValueOnce(prescriptionSnapshot({ status: 'REJECTED' }));
    await expect(command.execute(approveInput())).rejects.toMatchObject({
      code: 'INVALID_PRESCRIPTION_STATE_TRANSITION',
    });
  });
});
