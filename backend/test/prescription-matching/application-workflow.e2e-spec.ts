import { Injectable } from '@nestjs/common';
import { ApprovePrescriptionCommand } from '../../src/modules/prescription-matching/application/commands/approve-prescription.command';
import { AssignVerifyingPharmacyCommand } from '../../src/modules/prescription-matching/application/commands/assign-verifying-pharmacy.command';
import { CheckRxGateCommand } from '../../src/modules/prescription-matching/application/commands/check-rx-gate.command';
import { DispenseMedicineCommand } from '../../src/modules/prescription-matching/application/commands/dispense-medicine.command';
import { FindMatchCommand } from '../../src/modules/prescription-matching/application/commands/find-match.command';
import { RejectPrescriptionCommand } from '../../src/modules/prescription-matching/application/commands/reject-prescription.command';
import { RequestClarificationCommand } from '../../src/modules/prescription-matching/application/commands/request-clarification.command';
import { UploadPrescriptionCommand } from '../../src/modules/prescription-matching/application/commands/upload-prescription.command';
import { GetPrescriptionQuery } from '../../src/modules/prescription-matching/application/queries/get-prescription.query';
import { IUnitOfWork } from '../../src/modules/prescription-matching/application/ports/unit-of-work.port';
import { PrismaMatchRepository } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-match.repository';
import { PrismaDispenseLedgerRepository } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-dispense-ledger.repository';
import { PrismaPrescriptionRepository } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-prescription.repository';
import { PrismaUnitOfWork } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-unit-of-work';
import { PrismaVerificationRepository } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-verification.repository';
import { AuditService } from '../../src/shared/audit/audit.service';
import { AppLogger } from '../../src/shared/logging/app-logger.service';
import { CONFIG_PORT_STUB } from './config-stub';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { OutboxCapableClient, OutboxService } from '../../src/shared/outbox/outbox.service';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { FakeAvailabilityPort, FakeCatalogPort, FakeIdentityPort } from './fakes';
import { createPrisma, resetPrescriptionMatchingTables } from './support';

/** Mirrors `test/pharmacy-inventory/atomicity.e2e-spec.ts`'s `PoisonedOutboxService` exactly. */
@Injectable()
class PoisonedOutboxService extends OutboxService {
  armed = false;

  async write<T>(event: DomainEvent<T>, client?: OutboxCapableClient): Promise<void> {
    if (this.armed) {
      this.armed = false;
      throw new Error('CONTROLLED_FAILURE: simulated outbox failure after the state mutation, before commit');
    }
    return super.write(event, client);
  }
}

describe('Prescription & Matching application layer (e2e, real DB, in-memory cross-module ports)', () => {
  let prisma: PrismaService;
  let uow: IUnitOfWork;
  let prescriptions: PrismaPrescriptionRepository;
  let verifications: PrismaVerificationRepository;
  let ledger: PrismaDispenseLedgerRepository;
  let matches: PrismaMatchRepository;
  let audit: AuditService;
  let outbox: OutboxService;
  let poisonedOutbox: PoisonedOutboxService;
  let catalog: FakeCatalogPort;
  let identity: FakeIdentityPort;
  let availability: FakeAvailabilityPort;

  let uploadCmd: UploadPrescriptionCommand;
  let assignCmd: AssignVerifyingPharmacyCommand;
  let approveCmd: ApprovePrescriptionCommand;
  let rejectCmd: RejectPrescriptionCommand;
  let clarifyCmd: RequestClarificationCommand;
  let dispenseCmd: DispenseMedicineCommand;
  let checkRxGateCmd: CheckRxGateCommand;
  let findMatchCmd: FindMatchCommand;
  let getPrescriptionQuery: GetPrescriptionQuery;

  beforeAll(async () => {
    prisma = await createPrisma();
    uow = new PrismaUnitOfWork(prisma);
    prescriptions = new PrismaPrescriptionRepository(prisma);
    verifications = new PrismaVerificationRepository(prisma);
    ledger = new PrismaDispenseLedgerRepository(prisma);
    matches = new PrismaMatchRepository(prisma);
    audit = new AuditService(prisma, new AppLogger());
    outbox = new OutboxService(prisma);
    poisonedOutbox = new PoisonedOutboxService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetPrescriptionMatchingTables(prisma);
    catalog = new FakeCatalogPort();
    catalog.set({ id: 'product-1', status: 'ACTIVE', rxClassification: 'RX' });
    identity = new FakeIdentityPort();
    availability = new FakeAvailabilityPort();
    poisonedOutbox.armed = false;

    uploadCmd = new UploadPrescriptionCommand(prescriptions, CONFIG_PORT_STUB, uow, audit, outbox);
    assignCmd = new AssignVerifyingPharmacyCommand(prescriptions, uow, audit);
    approveCmd = new ApprovePrescriptionCommand(prescriptions, verifications, catalog, identity, uow, audit, outbox);
    rejectCmd = new RejectPrescriptionCommand(prescriptions, verifications, identity, uow, audit, outbox);
    clarifyCmd = new RequestClarificationCommand(prescriptions, verifications, identity, uow, audit);
    dispenseCmd = new DispenseMedicineCommand(prescriptions, ledger, uow, audit, outbox);
    checkRxGateCmd = new CheckRxGateCommand(prescriptions, catalog);
    findMatchCmd = new FindMatchCommand(matches, availability, CONFIG_PORT_STUB, uow, audit);
    getPrescriptionQuery = new GetPrescriptionQuery(prescriptions, identity);
  });

  async function uploadAssignApprove(options: { isSingleUse?: boolean; approvedQuantity?: number } = {}) {
    const prescription = await uploadCmd.execute({
      customerUserId: 'customer-1',
      fileRef: 'file-ref-1',
      fileType: 'application/pdf',
    });
    await assignCmd.execute({ prescriptionId: prescription.id, pharmacyId: 'pharmacy-1' });
    identity.grant('pharmacist-1', 'pharmacy-1', 'PHARMACIST');
    const approved = await approveCmd.execute({
      prescriptionId: prescription.id,
      reviewerUserId: 'pharmacist-1',
      lines: [
        {
          catalogProductId: 'product-1',
          approvedQuantity: options.approvedQuantity ?? 10,
          refillsAllowed: 0,
          isSingleUse: options.isSingleUse ?? false,
        },
      ],
      legibilityOk: true,
      validityOk: true,
    });
    const lines = await prescriptions.findLinesByPrescriptionId(approved.id);
    return { prescription: approved, line: lines[0] };
  }

  describe('upload -> assign -> approve happy path', () => {
    it('persists the full chain of state changes, audit entries, and outbox events', async () => {
      const { prescription, line } = await uploadAssignApprove();

      expect(prescription.status).toBe('APPROVED');
      expect(prescription.verifyingPharmacyId).toBe('pharmacy-1');
      expect(line.prescribedQuantity).toBe(10);
      expect(line.remainingDispensable).toBe(10);

      const reviews = await verifications.listByPrescriptionId(prescription.id);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].decision).toBe('APPROVED');

      const auditActions = (
        await prisma.auditLog.findMany({ where: { resourceId: prescription.id } })
      ).map((a) => a.action);
      expect(auditActions).toEqual(
        expect.arrayContaining(['PRESCRIPTION_UPLOADED', 'PRESCRIPTION_PHARMACY_ASSIGNED', 'PRESCRIPTION_APPROVED']),
      );

      const outboxTypes = (await prisma.outbox.findMany({ where: { aggregateId: prescription.id } })).map(
        (o) => o.eventType,
      );
      expect(outboxTypes).toEqual(
        expect.arrayContaining(['prescription.uploaded', 'prescription.approved']),
      );
    });
  });

  describe('reject flow', () => {
    it('rejects a PENDING_VERIFICATION prescription with a reason and emits PrescriptionRejected', async () => {
      const prescription = await uploadCmd.execute({
        customerUserId: 'customer-1',
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });
      await assignCmd.execute({ prescriptionId: prescription.id, pharmacyId: 'pharmacy-1' });
      identity.grant('pharmacist-1', 'pharmacy-1', 'PHARMACIST');

      const rejected = await rejectCmd.execute({
        prescriptionId: prescription.id,
        reviewerUserId: 'pharmacist-1',
        reason: 'Illegible handwriting',
      });

      expect(rejected.status).toBe('REJECTED');
      expect(rejected.rejectionReason).toBe('Illegible handwriting');
      expect(
        await prisma.outbox.count({ where: { eventType: 'prescription.rejected', aggregateId: prescription.id } }),
      ).toBe(1);
    });
  });

  describe('request clarification flow', () => {
    it('transitions to CLARIFICATION_REQUESTED with no outbox event', async () => {
      const prescription = await uploadCmd.execute({
        customerUserId: 'customer-1',
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });
      await assignCmd.execute({ prescriptionId: prescription.id, pharmacyId: 'pharmacy-1' });
      identity.grant('pharmacist-1', 'pharmacy-1', 'PHARMACIST');

      const clarified = await clarifyCmd.execute({
        prescriptionId: prescription.id,
        reviewerUserId: 'pharmacist-1',
        message: 'Please re-upload a legible copy',
      });

      expect(clarified.status).toBe('CLARIFICATION_REQUESTED');
      expect(await prisma.outbox.count({ where: { aggregateId: prescription.id } })).toBe(1); // upload only
    });
  });

  describe('dispensing (anti-reuse ledger, real DB idempotency)', () => {
    it('dispenses, decrements remainingDispensable, and a same-key replay does not double-decrement', async () => {
      const { line } = await uploadAssignApprove({ approvedQuantity: 10 });

      const first = await dispenseCmd.dispense({
        prescriptionLineId: line.id,
        idempotencyKey: 'idem-1',
        orderId: 'order-1',
        pharmacyId: 'pharmacy-1',
        quantity: 4,
        dispensedByUserId: 'staff-1',
      });
      const replay = await dispenseCmd.dispense({
        prescriptionLineId: line.id,
        idempotencyKey: 'idem-1',
        orderId: 'order-1',
        pharmacyId: 'pharmacy-1',
        quantity: 4,
        dispensedByUserId: 'staff-1',
      });

      expect(replay.dispenseRecordId).toBe(first.dispenseRecordId);
      expect(await prisma.dispenseRecord.count({ where: { prescriptionLineId: line.id } })).toBe(1);

      const updatedLine = await prescriptions.findLineById(line.id);
      expect(updatedLine?.dispensedQuantity).toBe(4);
      expect(updatedLine?.remainingDispensable).toBe(6);
    });

    it('rejects a dispense that would exceed remainingDispensable (BRULE-12) without any partial write', async () => {
      const { line } = await uploadAssignApprove({ approvedQuantity: 3 });

      await expect(
        dispenseCmd.dispense({
          prescriptionLineId: line.id,
          idempotencyKey: 'idem-over',
          orderId: 'order-1',
          pharmacyId: 'pharmacy-1',
          quantity: 5,
          dispensedByUserId: 'staff-1',
        }),
      ).rejects.toMatchObject({ code: 'PRESCRIPTION_EXHAUSTED' });

      expect(await prisma.dispenseRecord.count({ where: { prescriptionLineId: line.id } })).toBe(0);
      const updatedLine = await prescriptions.findLineById(line.id);
      expect(updatedLine?.remainingDispensable).toBe(3);
    });

    it('cascades to CONSUMED when a single-use line is fully exhausted, and the gate then blocks further use of it', async () => {
      const { prescription, line } = await uploadAssignApprove({ isSingleUse: true, approvedQuantity: 5 });

      await dispenseCmd.dispense({
        prescriptionLineId: line.id,
        idempotencyKey: 'idem-full',
        orderId: 'order-1',
        pharmacyId: 'pharmacy-1',
        quantity: 5,
        dispensedByUserId: 'staff-1',
      });

      const updated = await prescriptions.findById(prescription.id);
      expect(updated?.status).toBe('CONSUMED');

      const gate = await checkRxGateCmd.check({
        customerUserId: 'customer-1',
        items: [{ catalogProductId: 'product-1', quantity: 1 }],
      });
      // The prescription is no longer APPROVED (now CONSUMED), so listByCustomer({status:
      // APPROVED}) no longer returns it — the gate correctly finds no usable line.
      expect(gate.allowed).toBe(false);
    });

    it('resolves a true concurrent race on the same idempotency key to exactly one ledger row (DB unique-constraint race-safety)', async () => {
      const { line } = await uploadAssignApprove({ approvedQuantity: 10 });

      const results = await Promise.allSettled([
        dispenseCmd.dispense({
          prescriptionLineId: line.id,
          idempotencyKey: 'idem-race',
          orderId: 'order-a',
          pharmacyId: 'pharmacy-1',
          quantity: 2,
          dispensedByUserId: 'staff-1',
        }),
        dispenseCmd.dispense({
          prescriptionLineId: line.id,
          idempotencyKey: 'idem-race',
          orderId: 'order-b',
          pharmacyId: 'pharmacy-1',
          quantity: 3,
          dispensedByUserId: 'staff-2',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
        dispenseRecordId: string;
      }>[];
      expect(fulfilled).toHaveLength(2);
      expect(fulfilled[0].value.dispenseRecordId).toBe(fulfilled[1].value.dispenseRecordId);
      expect(await prisma.dispenseRecord.count({ where: { prescriptionLineId: line.id } })).toBe(1);
    });

    it('resolves a true concurrent race for the LAST remaining unit with two DISTINCT idempotency keys — exactly one wins, the other retries against committed state and resolves PRESCRIPTION_EXHAUSTED (§16 edge case 8)', async () => {
      // Exactly one dispensable unit left — two logically legitimate, independent callers
      // (distinct idempotencyKey per §6.3, unlike the same-key replay race above) both try to
      // dispense it at the same instant.
      const { line } = await uploadAssignApprove({ approvedQuantity: 1 });

      const results = await Promise.allSettled([
        dispenseCmd.dispense({
          prescriptionLineId: line.id,
          idempotencyKey: 'edge8-attempt-a',
          orderId: 'order-a',
          pharmacyId: 'pharmacy-1',
          quantity: 1,
          dispensedByUserId: 'staff-1',
        }),
        dispenseCmd.dispense({
          prescriptionLineId: line.id,
          idempotencyKey: 'edge8-attempt-b',
          orderId: 'order-b',
          pharmacyId: 'pharmacy-1',
          quantity: 1,
          dispensedByUserId: 'staff-2',
        }),
      ]);

      // Exactly one attempt succeeds; under Serializable isolation the loser is aborted as a
      // write-conflict on the same PrescriptionLine row, retried by runWithMatchRetry against
      // the now-committed (remainingDispensable = 0) state, and resolves deterministically to
      // PRESCRIPTION_EXHAUSTED — never a double-dispense, never an unhandled 500 (§8.1 step 10,
      // §16 edge case 8).
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{ dispenseRecordId: string }> => r.status === 'fulfilled',
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: 'PRESCRIPTION_EXHAUSTED' });

      // Exactly one ledger row was written, for the winning idempotency key only.
      const ledgerRows = await prisma.dispenseRecord.findMany({ where: { prescriptionLineId: line.id } });
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0].id).toBe(fulfilled[0].value.dispenseRecordId);
      const winningKey = ledgerRows[0].idempotencyKey;
      expect(['edge8-attempt-a', 'edge8-attempt-b']).toContain(winningKey);

      // Line cache is consistent: decremented exactly once, never negative.
      const updatedLine = await prescriptions.findLineById(line.id);
      expect(updatedLine?.dispensedQuantity).toBe(1);
      expect(updatedLine?.remainingDispensable).toBe(0);
      expect(updatedLine!.remainingDispensable).toBeGreaterThanOrEqual(0);

      // Audit/outbox rows correspond only to the one successful mutation — no orphaned rows
      // from the losing, retried-then-rejected attempt.
      expect(
        await prisma.auditLog.count({ where: { resourceId: line.id, action: 'MEDICINE_DISPENSED' } }),
      ).toBe(1);
      expect(
        await prisma.outbox.count({ where: { eventType: 'prescription.medicine_dispensed', aggregateId: line.id } }),
      ).toBe(1);
    });
  });

  describe('Rx gate (read-only)', () => {
    it('allows a product covered by an APPROVED line with sufficient remainingDispensable', async () => {
      await uploadAssignApprove({ approvedQuantity: 10 });
      const result = await checkRxGateCmd.check({
        customerUserId: 'customer-1',
        items: [{ catalogProductId: 'product-1', quantity: 5 }],
      });
      expect(result.allowed).toBe(true);
    });

    it('blocks with RX_REQUIRED when the customer has no approved line for the product', async () => {
      const result = await checkRxGateCmd.check({
        customerUserId: 'customer-without-rx',
        items: [{ catalogProductId: 'product-1', quantity: 1 }],
      });
      expect(result.allowed).toBe(false);
      expect(result.blocked[0].reason).toBe('RX_REQUIRED');
    });
  });

  describe('find match (real MatchRequest/MatchCandidate persistence, faked availability)', () => {
    it('ranks and persists full-coverage candidates only', async () => {
      availability.setAvailability('product-1', [
        { pharmacyId: 'pharmacy-near', branchId: 'branch-1', listingId: 'listing-1', price: 100, currency: 'ETB', sellable: 10, distanceMeters: 200 },
        { pharmacyId: 'pharmacy-far', branchId: 'branch-2', listingId: 'listing-2', price: 80, currency: 'ETB', sellable: 10, distanceMeters: 8000 },
        { pharmacyId: 'pharmacy-out-of-stock', branchId: 'branch-3', listingId: 'listing-3', price: 90, currency: 'ETB', sellable: 0 },
      ]);

      const result = await findMatchCmd.execute({
        customerUserId: 'customer-1',
        lines: [{ catalogProductId: 'product-1', quantity: 2 }],
      });

      expect(result.candidates).toHaveLength(2); // out-of-stock pharmacy excluded
      const persisted = await matches.listCandidates(result.matchRequest.id);
      expect(persisted).toHaveLength(2);
      expect(persisted.find((c) => c.pharmacyId === 'pharmacy-near')?.rank).toBe(1); // distance-dominant default
    });

    it('throws NO_PHARMACY_MATCH and persists nothing when no pharmacy covers the line', async () => {
      await expect(
        findMatchCmd.execute({
          customerUserId: 'customer-1',
          lines: [{ catalogProductId: 'product-1', quantity: 2 }],
        }),
      ).rejects.toMatchObject({ code: 'NO_PHARMACY_MATCH' });
      expect(await prisma.matchRequest.count()).toBe(0);
    });
  });

  describe('transaction atomicity — state + audit + outbox commit or roll back together', () => {
    it('a failure in the outbox write rolls back the entire approve transaction (status, lines, review, audit)', async () => {
      const prescription = await uploadCmd.execute({
        customerUserId: 'customer-1',
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });
      await assignCmd.execute({ prescriptionId: prescription.id, pharmacyId: 'pharmacy-1' });
      identity.grant('pharmacist-1', 'pharmacy-1', 'PHARMACIST');

      const poisonedApprove = new ApprovePrescriptionCommand(
        prescriptions,
        verifications,
        catalog,
        identity,
        uow,
        audit,
        poisonedOutbox,
      );
      poisonedOutbox.armed = true;

      await expect(
        poisonedApprove.execute({
          prescriptionId: prescription.id,
          reviewerUserId: 'pharmacist-1',
          lines: [
            { catalogProductId: 'product-1', approvedQuantity: 10, refillsAllowed: 0, isSingleUse: false },
          ],
          legibilityOk: true,
          validityOk: true,
        }),
      ).rejects.toThrow('CONTROLLED_FAILURE');

      expect(poisonedOutbox.armed).toBe(false); // the throw actually happened

      const afterFailure = await prescriptions.findById(prescription.id);
      expect(afterFailure?.status).toBe('PENDING_VERIFICATION'); // rolled back, not APPROVED
      expect(await prisma.prescriptionLine.count({ where: { prescriptionId: prescription.id } })).toBe(0);
      expect(await verifications.listByPrescriptionId(prescription.id)).toEqual([]);
      expect(
        await prisma.auditLog.count({ where: { resourceId: prescription.id, action: 'PRESCRIPTION_APPROVED' } }),
      ).toBe(0);

      // Retrying (unpoisoned) succeeds cleanly.
      const retried = await approveCmd.execute({
        prescriptionId: prescription.id,
        reviewerUserId: 'pharmacist-1',
        lines: [
          { catalogProductId: 'product-1', approvedQuantity: 10, refillsAllowed: 0, isSingleUse: false },
        ],
        legibilityOk: true,
        validityOk: true,
      });
      expect(retried.status).toBe('APPROVED');
    });

    it('a failure in the outbox write rolls back the entire upload transaction (no orphaned Prescription/audit row) — §18.3', async () => {
      const poisonedUpload = new UploadPrescriptionCommand(prescriptions, CONFIG_PORT_STUB, uow, audit, poisonedOutbox);
      poisonedOutbox.armed = true;

      await expect(
        poisonedUpload.execute({
          customerUserId: 'customer-1',
          fileRef: 'file-ref-1',
          fileType: 'application/pdf',
        }),
      ).rejects.toThrow('CONTROLLED_FAILURE');

      expect(poisonedOutbox.armed).toBe(false); // the throw actually happened
      expect(await prisma.prescription.count({ where: { customerUserId: 'customer-1' } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: 'PRESCRIPTION_UPLOADED' } })).toBe(0);
      expect(await prisma.outbox.count({ where: { eventType: 'prescription.uploaded' } })).toBe(0);

      // Retrying (unpoisoned) succeeds cleanly.
      const retried = await uploadCmd.execute({
        customerUserId: 'customer-1',
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });
      expect(retried.status).toBe('UPLOADED');
    });

    it('a failure in the outbox write rolls back the entire reject transaction (status, review, audit) — §18.3', async () => {
      const prescription = await uploadCmd.execute({
        customerUserId: 'customer-1',
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });
      await assignCmd.execute({ prescriptionId: prescription.id, pharmacyId: 'pharmacy-1' });
      identity.grant('pharmacist-1', 'pharmacy-1', 'PHARMACIST');

      const poisonedReject = new RejectPrescriptionCommand(
        prescriptions,
        verifications,
        identity,
        uow,
        audit,
        poisonedOutbox,
      );
      poisonedOutbox.armed = true;

      await expect(
        poisonedReject.execute({
          prescriptionId: prescription.id,
          reviewerUserId: 'pharmacist-1',
          reason: 'Illegible handwriting',
        }),
      ).rejects.toThrow('CONTROLLED_FAILURE');

      expect(poisonedOutbox.armed).toBe(false); // the throw actually happened
      const afterFailure = await prescriptions.findById(prescription.id);
      expect(afterFailure?.status).toBe('PENDING_VERIFICATION'); // rolled back, not REJECTED
      expect(afterFailure?.rejectionReason).toBeNull();
      expect(await verifications.listByPrescriptionId(prescription.id)).toEqual([]);
      expect(
        await prisma.auditLog.count({ where: { resourceId: prescription.id, action: 'PRESCRIPTION_REJECTED' } }),
      ).toBe(0);

      // Retrying (unpoisoned) succeeds cleanly.
      const retried = await rejectCmd.execute({
        prescriptionId: prescription.id,
        reviewerUserId: 'pharmacist-1',
        reason: 'Illegible handwriting',
      });
      expect(retried.status).toBe('REJECTED');
    });

    it('a failure in the outbox write rolls back the entire dispense transaction (no ledger row, no cache-column change) — §18.3', async () => {
      const { line } = await uploadAssignApprove({ approvedQuantity: 10 });

      const poisonedDispense = new DispenseMedicineCommand(prescriptions, ledger, uow, audit, poisonedOutbox);
      poisonedOutbox.armed = true;

      await expect(
        poisonedDispense.dispense({
          prescriptionLineId: line.id,
          idempotencyKey: 'idem-poisoned',
          orderId: 'order-1',
          pharmacyId: 'pharmacy-1',
          quantity: 4,
          dispensedByUserId: 'staff-1',
        }),
      ).rejects.toThrow('CONTROLLED_FAILURE');

      expect(poisonedOutbox.armed).toBe(false); // the throw actually happened
      expect(await prisma.dispenseRecord.count({ where: { prescriptionLineId: line.id } })).toBe(0);
      const afterFailure = await prescriptions.findLineById(line.id);
      expect(afterFailure?.dispensedQuantity).toBe(0); // rolled back, not decremented
      expect(afterFailure?.remainingDispensable).toBe(10);
      expect(
        await prisma.auditLog.count({ where: { resourceId: line.id, action: 'MEDICINE_DISPENSED' } }),
      ).toBe(0);
      expect(await prisma.outbox.count({ where: { eventType: 'prescription.medicine_dispensed' } })).toBe(0);

      // Retrying (unpoisoned) succeeds cleanly.
      const retried = await dispenseCmd.dispense({
        prescriptionLineId: line.id,
        idempotencyKey: 'idem-poisoned',
        orderId: 'order-1',
        pharmacyId: 'pharmacy-1',
        quantity: 4,
        dispensedByUserId: 'staff-1',
      });
      expect(retried.dispenseRecordId).toEqual(expect.any(String));
      const updatedLine = await prescriptions.findLineById(line.id);
      expect(updatedLine?.dispensedQuantity).toBe(4);
    });
  });

  describe('GetPrescriptionQuery access logging (real DB)', () => {
    it('logs ALLOW for the owner and DENY for a stranger', async () => {
      const prescription = await uploadCmd.execute({
        customerUserId: 'customer-1',
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });

      await getPrescriptionQuery.execute({ prescriptionId: prescription.id, requestingUserId: 'customer-1' });
      await expect(
        getPrescriptionQuery.execute({ prescriptionId: prescription.id, requestingUserId: 'stranger-1' }),
      ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });

      const logs = await prisma.prescriptionAccessLog.findMany({
        where: { prescriptionId: prescription.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(logs.map((l) => l.outcome)).toEqual(['ALLOW', 'DENY']);
    });
  });
});
