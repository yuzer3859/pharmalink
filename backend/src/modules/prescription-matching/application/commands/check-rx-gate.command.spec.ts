import {
  IPrescriptionRepository,
  PrescriptionLineSnapshot,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import { ICatalogPort } from '../ports/outbound/catalog.port';
import { CheckRxGateCommand } from './check-rx-gate.command';

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

function lineSnapshot(overrides: Partial<PrescriptionLineSnapshot> = {}): PrescriptionLineSnapshot {
  return {
    id: 'line-1',
    prescriptionId: 'prescription-1',
    catalogProductId: 'product-1',
    rawText: null,
    prescribedQuantity: 10,
    refillsAllowed: 0,
    dispensedQuantity: 0,
    remainingDispensable: 10,
    isSingleUse: false,
    createdAt: new Date(),
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
    findLinesByPrescriptionId: jest.fn().mockResolvedValue([lineSnapshot()]),
    createApprovedLines: jest.fn(),
    updateLineDispenseState: jest.fn(),
    logAccess: jest.fn(),
  };
  const catalog: jest.Mocked<ICatalogPort> = {
    getProduct: jest.fn().mockResolvedValue({ id: 'product-1', status: 'ACTIVE', rxClassification: 'RX' }),
  };

  const command = new CheckRxGateCommand(prescriptions, catalog);
  return { command, prescriptions, catalog };
}

describe('CheckRxGateCommand', () => {
  it('allows an Rx line covered by an APPROVED, non-expired, sufficiently-remaining line', async () => {
    const { command } = build();
    const result = await command.check({
      customerUserId: 'customer-1',
      items: [{ catalogProductId: 'product-1', quantity: 5 }],
    });
    expect(result.allowed).toBe(true);
    expect(result.blocked).toEqual([]);
    expect(result.usablePrescriptionLineIds).toEqual(['line-1']);
  });

  it('always passes an unclassified (HEALTH_PRODUCT) line, regardless of prescription coverage', async () => {
    const { command, catalog } = build();
    catalog.getProduct.mockResolvedValue({ id: 'product-2', status: 'ACTIVE', rxClassification: null });
    const result = await command.check({
      customerUserId: 'customer-1',
      items: [{ catalogProductId: 'product-2', quantity: 100 }],
    });
    expect(result.allowed).toBe(true);
  });

  it('always passes an OTC medicine (rxClassification "OTC"), regardless of prescription coverage', async () => {
    // Regression: `Boolean(rxClassification)` was true for the string 'OTC', so an OTC medicine
    // was treated as Rx and blocked — contradicting §12's "OTC always allowed" gate matrix. The
    // case above covers `null` (a HEALTH_PRODUCT); this covers a real, classified OTC medicine,
    // which is the only shape a MEDICINE can take without requiring a prescription.
    const { command, catalog, prescriptions } = build();
    catalog.getProduct.mockResolvedValue({ id: 'product-2', status: 'ACTIVE', rxClassification: 'OTC' });
    prescriptions.listByCustomer.mockResolvedValue({ items: [], total: 0 });

    const result = await command.check({
      customerUserId: 'customer-1',
      items: [{ catalogProductId: 'product-2', quantity: 100 }],
    });

    expect(result.allowed).toBe(true);
    expect(result.blocked).toEqual([]);
  });

  it('blocks with RX_REQUIRED when no APPROVED line exists for the product at all', async () => {
    const { command, prescriptions } = build();
    prescriptions.listByCustomer.mockResolvedValue({ items: [], total: 0 });
    const result = await command.check({
      customerUserId: 'customer-1',
      items: [{ catalogProductId: 'product-1', quantity: 5 }],
    });
    expect(result.allowed).toBe(false);
    expect(result.blocked).toEqual([{ catalogProductId: 'product-1', reason: 'RX_REQUIRED' }]);
  });

  it('blocks with PRESCRIPTION_EXHAUSTED when remainingDispensable is insufficient', async () => {
    const { command, prescriptions } = build();
    prescriptions.findLinesByPrescriptionId.mockResolvedValue([
      lineSnapshot({ remainingDispensable: 2 }),
    ]);
    const result = await command.check({
      customerUserId: 'customer-1',
      items: [{ catalogProductId: 'product-1', quantity: 5 }],
    });
    expect(result.blocked).toEqual([{ catalogProductId: 'product-1', reason: 'PRESCRIPTION_EXHAUSTED' }]);
  });

  it('blocks with PRESCRIPTION_EXPIRED when every matching line is expired', async () => {
    const { command, prescriptions } = build();
    prescriptions.listByCustomer.mockResolvedValue({
      items: [prescriptionSnapshot({ expiryDate: new Date(Date.now() - 1000) })],
      total: 1,
    });
    const result = await command.check({
      customerUserId: 'customer-1',
      items: [{ catalogProductId: 'product-1', quantity: 5 }],
    });
    expect(result.blocked).toEqual([{ catalogProductId: 'product-1', reason: 'PRESCRIPTION_EXPIRED' }]);
  });

  it('ignores unapproved lines with a null catalogProductId', async () => {
    const { command, prescriptions } = build();
    prescriptions.findLinesByPrescriptionId.mockResolvedValue([
      lineSnapshot({ catalogProductId: null }),
    ]);
    const result = await command.check({
      customerUserId: 'customer-1',
      items: [{ catalogProductId: 'product-1', quantity: 1 }],
    });
    expect(result.allowed).toBe(false);
  });
});
