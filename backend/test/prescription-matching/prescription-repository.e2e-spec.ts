import { PrismaPrescriptionRepository } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-prescription.repository';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { createPrisma, resetPrescriptionMatchingTables } from './support';

describe('PrismaPrescriptionRepository (e2e)', () => {
  let prisma: PrismaService;
  let repo: PrismaPrescriptionRepository;

  beforeAll(async () => {
    prisma = await createPrisma();
    repo = new PrismaPrescriptionRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetPrescriptionMatchingTables(prisma);
  });

  describe('create / findById', () => {
    it('persists a new prescription and round-trips every field', async () => {
      const issueDate = new Date('2026-01-01T00:00:00.000Z');
      const expiryDate = new Date('2027-01-01T00:00:00.000Z');
      const retentionUntil = new Date('2033-01-01T00:00:00.000Z');

      const created = await repo.create({
        customerUserId: 'customer-1',
        beneficiaryId: 'beneficiary-1',
        fileRef: 'file-ref-1',
        encryptionKeyRef: 'key-ref-1',
        fileType: 'application/pdf',
        doctorName: 'Dr. Almaz',
        hospitalName: 'St. Paul Hospital',
        issueDate,
        expiryDate,
        retentionUntil,
      });

      expect(created.id).toEqual(expect.any(String));
      expect(created.status).toBe('UPLOADED');
      expect(created.customerUserId).toBe('customer-1');
      expect(created.beneficiaryId).toBe('beneficiary-1');
      expect(created.fileRef).toBe('file-ref-1');
      expect(created.encryptionKeyRef).toBe('key-ref-1');
      expect(created.fileType).toBe('application/pdf');
      expect(created.doctorName).toBe('Dr. Almaz');
      expect(created.hospitalName).toBe('St. Paul Hospital');
      expect(created.issueDate).toEqual(issueDate);
      expect(created.expiryDate).toEqual(expiryDate);
      expect(created.retentionUntil).toEqual(retentionUntil);
      expect(created.verifiedByUserId).toBeNull();
      expect(created.verifiedAt).toBeNull();
      expect(created.verifyingPharmacyId).toBeNull();
      expect(created.rejectionReason).toBeNull();

      const found = await repo.findById(created.id);
      expect(found).toEqual(created);
    });

    it('applies defaults for a minimal upload (§5.1 — most fields optional)', async () => {
      const created = await repo.create({ customerUserId: 'customer-2' });
      expect(created.status).toBe('UPLOADED');
      expect(created.beneficiaryId).toBeNull();
      expect(created.fileRef).toBeNull();
    });

    it('returns null for an unknown id', async () => {
      await expect(repo.findById('00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('transitions status and sets the verification header fields (§10.2 approve)', async () => {
      const created = await repo.create({ customerUserId: 'customer-3' });
      const verifiedAt = new Date('2026-02-01T00:00:00.000Z');

      await repo.updateStatus(created.id, {
        status: 'APPROVED',
        verifiedByUserId: 'pharmacist-1',
        verifiedAt,
        verifyingPharmacyId: 'pharmacy-1',
      });

      const updated = await repo.findById(created.id);
      expect(updated?.status).toBe('APPROVED');
      expect(updated?.verifiedByUserId).toBe('pharmacist-1');
      expect(updated?.verifiedAt).toEqual(verifiedAt);
      expect(updated?.verifyingPharmacyId).toBe('pharmacy-1');
    });

    it('sets a mandatory rejection reason on reject (BRULE-14)', async () => {
      const created = await repo.create({ customerUserId: 'customer-4' });
      await repo.updateStatus(created.id, {
        status: 'REJECTED',
        rejectionReason: 'Illegible handwriting',
      });
      const updated = await repo.findById(created.id);
      expect(updated?.status).toBe('REJECTED');
      expect(updated?.rejectionReason).toBe('Illegible handwriting');
    });

    it('leaves fields the caller omits untouched (partial update)', async () => {
      const created = await repo.create({ customerUserId: 'customer-5', fileRef: 'original-ref' });
      await repo.updateStatus(created.id, { status: 'PENDING_VERIFICATION' });
      const updated = await repo.findById(created.id);
      expect(updated?.status).toBe('PENDING_VERIFICATION');
      expect(updated?.fileRef).toBe('original-ref');
    });
  });

  describe('listByCustomer', () => {
    it('paginates and filters by owner and status', async () => {
      await repo.create({ customerUserId: 'customer-list-1' });
      const second = await repo.create({ customerUserId: 'customer-list-1' });
      await repo.updateStatus(second.id, { status: 'APPROVED' });
      await repo.create({ customerUserId: 'customer-list-2' }); // different owner, excluded

      const all = await repo.listByCustomer({ customerUserId: 'customer-list-1', page: 1, size: 10 });
      expect(all.total).toBe(2);
      expect(all.items).toHaveLength(2);
      expect(all.items.every((p) => p.customerUserId === 'customer-list-1')).toBe(true);

      const approvedOnly = await repo.listByCustomer({
        customerUserId: 'customer-list-1',
        status: 'APPROVED',
        page: 1,
        size: 10,
      });
      expect(approvedOnly.total).toBe(1);
      expect(approvedOnly.items[0].id).toBe(second.id);
    });

    it('respects page/size', async () => {
      for (let i = 0; i < 3; i += 1) {
        await repo.create({ customerUserId: 'customer-page' });
      }
      const page1 = await repo.listByCustomer({ customerUserId: 'customer-page', page: 1, size: 2 });
      const page2 = await repo.listByCustomer({ customerUserId: 'customer-page', page: 2, size: 2 });
      expect(page1.total).toBe(3);
      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(1);
    });
  });

  describe('listVerificationQueue', () => {
    it('scopes to verifyingPharmacyId and only PENDING_VERIFICATION prescriptions (§10.2)', async () => {
      const pending = await repo.create({ customerUserId: 'customer-q1' });
      await repo.updateStatus(pending.id, {
        status: 'PENDING_VERIFICATION',
        verifyingPharmacyId: 'pharmacy-q1',
      });

      const approved = await repo.create({ customerUserId: 'customer-q2' });
      await repo.updateStatus(approved.id, {
        status: 'APPROVED',
        verifyingPharmacyId: 'pharmacy-q1',
      });

      const otherPharmacy = await repo.create({ customerUserId: 'customer-q3' });
      await repo.updateStatus(otherPharmacy.id, {
        status: 'PENDING_VERIFICATION',
        verifyingPharmacyId: 'pharmacy-q2',
      });

      const queue = await repo.listVerificationQueue({
        verifyingPharmacyId: 'pharmacy-q1',
        page: 1,
        size: 10,
      });
      expect(queue.total).toBe(1);
      expect(queue.items[0].id).toBe(pending.id);
    });
  });

  describe('prescription lines', () => {
    it('createApprovedLines inserts one row per approved line with remainingDispensable seeded from prescribedQuantity (§3.2)', async () => {
      const prescription = await repo.create({ customerUserId: 'customer-lines-1' });

      const lines = await repo.createApprovedLines(prescription.id, [
        { catalogProductId: 'product-1', prescribedQuantity: 30, refillsAllowed: 2, isSingleUse: false },
        {
          catalogProductId: 'product-2',
          rawText: 'Amoxicillin 500mg',
          prescribedQuantity: 10,
          refillsAllowed: 0,
          isSingleUse: true,
        },
      ]);

      expect(lines).toHaveLength(2);
      const first = lines.find((l) => l.catalogProductId === 'product-1');
      expect(first?.prescribedQuantity).toBe(30);
      expect(first?.remainingDispensable).toBe(30);
      expect(first?.dispensedQuantity).toBe(0);
      expect(first?.refillsAllowed).toBe(2);
      expect(first?.isSingleUse).toBe(false);

      const second = lines.find((l) => l.catalogProductId === 'product-2');
      expect(second?.rawText).toBe('Amoxicillin 500mg');
      expect(second?.isSingleUse).toBe(true);

      const found = await repo.findLinesByPrescriptionId(prescription.id);
      expect(found).toHaveLength(2);

      const byId = await repo.findLineById(first!.id);
      expect(byId?.id).toBe(first!.id);
    });

    it('findLineById returns null for an unknown line', async () => {
      await expect(repo.findLineById('00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
    });

    it('updateLineDispenseState persists the recomputed derived cache (§3.11 invariant 3, §8.1 step 6)', async () => {
      const prescription = await repo.create({ customerUserId: 'customer-lines-2' });
      const [line] = await repo.createApprovedLines(prescription.id, [
        { catalogProductId: 'product-3', prescribedQuantity: 20, refillsAllowed: 0, isSingleUse: false },
      ]);

      await repo.updateLineDispenseState(line.id, 5, 15);

      const updated = await repo.findLineById(line.id);
      expect(updated?.dispensedQuantity).toBe(5);
      expect(updated?.remainingDispensable).toBe(15);
    });
  });

  describe('logAccess', () => {
    it('appends an access-log row for both allow and deny outcomes (FR-REC-06)', async () => {
      const prescription = await repo.create({ customerUserId: 'customer-access-1' });

      await repo.logAccess({
        prescriptionId: prescription.id,
        actorUserId: 'customer-access-1',
        role: 'CUSTOMER',
        accessType: 'VIEW',
        outcome: 'ALLOW',
      });
      await repo.logAccess({
        prescriptionId: prescription.id,
        actorUserId: 'stranger-1',
        role: null,
        accessType: 'VIEW',
        outcome: 'DENY',
      });

      const rows = await prisma.prescriptionAccessLog.findMany({
        where: { prescriptionId: prescription.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].outcome).toBe('ALLOW');
      expect(rows[1].outcome).toBe('DENY');
      expect(rows[1].role).toBeNull();
    });
  });

  describe('transaction client (tx?: unknown) handling', () => {
    it('participates in the caller-supplied transaction: a rollback discards the write', async () => {
      let createdId: string | undefined;
      await expect(
        prisma.$transaction(async (tx) => {
          const created = await repo.create({ customerUserId: 'customer-tx-1' }, tx);
          createdId = created.id;
          // A read through the same tx handle must see the uncommitted write.
          const seenInTx = await repo.findById(created.id, tx);
          expect(seenInTx).not.toBeNull();
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      const seenAfterRollback = await repo.findById(createdId!);
      expect(seenAfterRollback).toBeNull();
    });

    it('commits normally when the transaction succeeds', async () => {
      const createdId = await prisma.$transaction(async (tx) => {
        const created = await repo.create({ customerUserId: 'customer-tx-2' }, tx);
        await repo.updateStatus(created.id, { status: 'PENDING_VERIFICATION' }, tx);
        return created.id;
      });

      const found = await repo.findById(createdId);
      expect(found?.status).toBe('PENDING_VERIFICATION');
    });
  });
});
