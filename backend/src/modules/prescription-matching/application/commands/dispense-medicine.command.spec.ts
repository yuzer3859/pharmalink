import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  DispenseRecordSnapshot,
  IDispenseLedgerRepository,
} from '../../domain/repositories/dispense-ledger.repository';
import {
  IPrescriptionRepository,
  PrescriptionLineSnapshot,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { DispenseMedicineCommand } from './dispense-medicine.command';

function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

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

function recordSnapshot(overrides: Partial<DispenseRecordSnapshot> = {}): DispenseRecordSnapshot {
  return {
    id: 'record-1',
    prescriptionLineId: 'line-1',
    idempotencyKey: 'idem-1',
    orderId: 'order-1',
    pharmacyId: 'pharmacy-1',
    quantity: 5,
    dispensedByUserId: 'staff-1',
    stockMovementId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function build() {
  const line = lineSnapshot();
  const prescription = prescriptionSnapshot();
  const prescriptions: jest.Mocked<IPrescriptionRepository> = {
    findById: jest.fn().mockResolvedValue(prescription),
    create: jest.fn(),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    listByCustomer: jest.fn(),
    listVerificationQueue: jest.fn(),
    findLineById: jest.fn().mockResolvedValue(line),
    findLinesByPrescriptionId: jest.fn(),
    createApprovedLines: jest.fn(),
    updateLineDispenseState: jest.fn().mockResolvedValue(undefined),
    logAccess: jest.fn(),
  };
  const ledger: jest.Mocked<IDispenseLedgerRepository> = {
    findByIdempotencyKey: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(recordSnapshot()),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new DispenseMedicineCommand(prescriptions, ledger, uow, audit, outbox);
  return { command, prescriptions, ledger, audit, outbox };
}

function dispenseInput(overrides: Record<string, unknown> = {}) {
  return {
    prescriptionLineId: 'line-1',
    idempotencyKey: 'idem-1',
    orderId: 'order-1',
    pharmacyId: 'pharmacy-1',
    quantity: 5,
    dispensedByUserId: 'staff-1',
    ...overrides,
  };
}

describe('DispenseMedicineCommand', () => {
  it('dispenses and recomputes the derived remainingDispensable cache', async () => {
    const { command, prescriptions, ledger, audit, outbox } = build();
    const result = await command.dispense(dispenseInput());

    expect(result.dispenseRecordId).toBe('record-1');
    expect(ledger.create).toHaveBeenCalledWith(
      expect.objectContaining({ prescriptionLineId: 'line-1', idempotencyKey: 'idem-1', quantity: 5 }),
      undefined,
    );
    expect(prescriptions.updateLineDispenseState).toHaveBeenCalledWith('line-1', 5, 5, undefined);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MEDICINE_DISPENSED' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('is a pure replay for an existing (prescriptionLineId, idempotencyKey) pair — no policy re-check, no re-decrement', async () => {
    const { command, ledger, prescriptions } = build();
    ledger.findByIdempotencyKey.mockResolvedValue(recordSnapshot({ id: 'existing-record' }));

    const result = await command.dispense(dispenseInput());

    expect(result.dispenseRecordId).toBe('existing-record');
    expect(ledger.create).not.toHaveBeenCalled();
    expect(prescriptions.updateLineDispenseState).not.toHaveBeenCalled();
  });

  it('404s when the prescription line does not exist', async () => {
    const { command, prescriptions } = build();
    prescriptions.findLineById.mockResolvedValue(null);
    await expect(command.dispense(dispenseInput())).rejects.toMatchObject({
      code: 'PRESCRIPTION_NOT_FOUND',
    });
  });

  it('throws PRESCRIPTION_EXHAUSTED when the requested quantity exceeds remainingDispensable', async () => {
    const { command, prescriptions } = build();
    prescriptions.findLineById.mockResolvedValue(lineSnapshot({ remainingDispensable: 2 }));
    await expect(command.dispense(dispenseInput({ quantity: 5 }))).rejects.toMatchObject({
      code: 'PRESCRIPTION_EXHAUSTED',
    });
  });

  it('throws PRESCRIPTION_EXPIRED when the parent prescription has passed its expiryDate', async () => {
    const { command, prescriptions } = build();
    prescriptions.findById.mockResolvedValue(
      prescriptionSnapshot({ expiryDate: new Date(Date.now() - 1000) }),
    );
    await expect(command.dispense(dispenseInput())).rejects.toMatchObject({
      code: 'PRESCRIPTION_EXPIRED',
    });
  });

  it('cascades Prescription.status -> CONSUMED when a single-use line is fully exhausted', async () => {
    const { command, prescriptions } = build();
    prescriptions.findLineById.mockResolvedValue(
      lineSnapshot({ isSingleUse: true, remainingDispensable: 5, prescribedQuantity: 5 }),
    );
    await command.dispense(dispenseInput({ quantity: 5 }));

    expect(prescriptions.updateStatus).toHaveBeenCalledWith(
      'prescription-1',
      { status: 'CONSUMED' },
      undefined,
    );
  });

  it('does not cascade to CONSUMED when the line still has remaining quantity', async () => {
    const { command, prescriptions } = build();
    await command.dispense(dispenseInput({ quantity: 5 })); // line has 10 remaining
    expect(prescriptions.updateStatus).not.toHaveBeenCalled();
  });

  it('does not cascade to CONSUMED for a multi-use (non-single-use) line even if exhausted', async () => {
    const { command, prescriptions } = build();
    prescriptions.findLineById.mockResolvedValue(
      lineSnapshot({ isSingleUse: false, remainingDispensable: 5, prescribedQuantity: 5 }),
    );
    await command.dispense(dispenseInput({ quantity: 5 }));
    expect(prescriptions.updateStatus).not.toHaveBeenCalled();
  });

  it('resolves a concurrent unique-constraint race by re-reading the winning row as a replay', async () => {
    const { command, ledger } = build();
    ledger.create.mockRejectedValueOnce(uniqueViolation());
    ledger.findByIdempotencyKey
      .mockResolvedValueOnce(null) // pre-check inside the losing attempt
      .mockResolvedValueOnce(recordSnapshot({ id: 'winner-record' })); // post-catch re-read

    const result = await command.dispense(dispenseInput());
    expect(result.dispenseRecordId).toBe('winner-record');
  });

  it('rethrows a non-conflict persistence error unchanged (no retry)', async () => {
    const { command, ledger } = build();
    const boom = new Error('disk full');
    ledger.create.mockRejectedValue(boom);
    await expect(command.dispense(dispenseInput())).rejects.toBe(boom);
  });
});
