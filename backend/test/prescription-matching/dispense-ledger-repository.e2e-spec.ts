import { Prisma } from '@prisma/client';
import { PrismaDispenseLedgerRepository } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-dispense-ledger.repository';
import { PrismaPrescriptionRepository } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-prescription.repository';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { createPrisma, resetPrescriptionMatchingTables } from './support';

describe('PrismaDispenseLedgerRepository (e2e)', () => {
  let prisma: PrismaService;
  let repo: PrismaDispenseLedgerRepository;
  let prescriptions: PrismaPrescriptionRepository;

  beforeAll(async () => {
    prisma = await createPrisma();
    repo = new PrismaDispenseLedgerRepository(prisma);
    prescriptions = new PrismaPrescriptionRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetPrescriptionMatchingTables(prisma);
  });

  async function seedLine(prescribedQuantity = 30) {
    const prescription = await prescriptions.create({ customerUserId: 'customer-1' });
    const [line] = await prescriptions.createApprovedLines(prescription.id, [
      { catalogProductId: 'product-1', prescribedQuantity, refillsAllowed: 0, isSingleUse: false },
    ]);
    return line;
  }

  describe('findByIdempotencyKey', () => {
    it('returns null when no previous record exists for the (line, key) pair (§6.3)', async () => {
      const line = await seedLine();
      await expect(repo.findByIdempotencyKey(line.id, 'idem-unseen')).resolves.toBeNull();
    });

    it('returns the existing record for an exact (line, key) match — the replay case', async () => {
      const line = await seedLine();
      const created = await repo.create({
        prescriptionLineId: line.id,
        idempotencyKey: 'idem-1',
        orderId: 'order-1',
        pharmacyId: 'pharmacy-1',
        quantity: 5,
        dispensedByUserId: 'staff-1',
      });

      const found = await repo.findByIdempotencyKey(line.id, 'idem-1');
      expect(found).toEqual(created);
    });

    it('does not match the same key against a different line', async () => {
      const lineA = await seedLine();
      const lineB = await seedLine();
      await repo.create({
        prescriptionLineId: lineA.id,
        idempotencyKey: 'idem-shared',
        orderId: 'order-a',
        pharmacyId: 'pharmacy-1',
        quantity: 2,
        dispensedByUserId: 'staff-1',
      });

      await expect(repo.findByIdempotencyKey(lineB.id, 'idem-shared')).resolves.toBeNull();
    });
  });

  describe('create', () => {
    it('appends a dispense record and round-trips every field (§3.4)', async () => {
      const line = await seedLine();
      const record = await repo.create({
        prescriptionLineId: line.id,
        idempotencyKey: 'idem-2',
        orderId: 'order-2',
        pharmacyId: 'pharmacy-2',
        quantity: 7,
        dispensedByUserId: 'staff-2',
        stockMovementId: 'movement-1',
      });

      expect(record.id).toEqual(expect.any(String));
      expect(record.prescriptionLineId).toBe(line.id);
      expect(record.idempotencyKey).toBe('idem-2');
      expect(record.orderId).toBe('order-2');
      expect(record.pharmacyId).toBe('pharmacy-2');
      expect(record.quantity).toBe(7);
      expect(record.dispensedByUserId).toBe('staff-2');
      expect(record.stockMovementId).toBe('movement-1');
      expect(record.createdAt).toEqual(expect.any(Date));
    });

    it('allows two different idempotency keys against the same line (two distinct dispenses)', async () => {
      const line = await seedLine();
      await repo.create({
        prescriptionLineId: line.id,
        idempotencyKey: 'idem-a',
        orderId: 'order-a',
        pharmacyId: 'pharmacy-1',
        quantity: 2,
        dispensedByUserId: 'staff-1',
      });
      await repo.create({
        prescriptionLineId: line.id,
        idempotencyKey: 'idem-b',
        orderId: 'order-b',
        pharmacyId: 'pharmacy-1',
        quantity: 3,
        dispensedByUserId: 'staff-1',
      });

      const count = await prisma.dispenseRecord.count({ where: { prescriptionLineId: line.id } });
      expect(count).toBe(2);
    });

    it(
      'rejects a second insert reusing the same (prescriptionLineId, idempotencyKey) pair for a ' +
        'genuinely different dispense via the DB-level unique constraint, rather than silently ' +
        'converting it into a fake replay (§6.3 — replay semantics belong to the future command)',
      async () => {
        const line = await seedLine();
        await repo.create({
          prescriptionLineId: line.id,
          idempotencyKey: 'idem-conflict',
          orderId: 'order-first',
          pharmacyId: 'pharmacy-1',
          quantity: 2,
          dispensedByUserId: 'staff-1',
        });

        await expect(
          repo.create({
            prescriptionLineId: line.id,
            idempotencyKey: 'idem-conflict',
            orderId: 'order-second', // different logical dispense, same key
            pharmacyId: 'pharmacy-1',
            quantity: 9,
            dispensedByUserId: 'staff-1',
          }),
        ).rejects.toMatchObject({ code: 'P2002' });

        expect(
          await prisma.dispenseRecord.count({
            where: { prescriptionLineId: line.id, idempotencyKey: 'idem-conflict' },
          }),
        ).toBe(1);
      },
    );

    it('surfaces the DB unique-constraint race as P2002 even under true concurrency (not an app-level pre-check)', async () => {
      const line = await seedLine();

      const results = await Promise.allSettled([
        repo.create({
          prescriptionLineId: line.id,
          idempotencyKey: 'idem-race',
          orderId: 'order-race-a',
          pharmacyId: 'pharmacy-1',
          quantity: 1,
          dispensedByUserId: 'staff-1',
        }),
        repo.create({
          prescriptionLineId: line.id,
          idempotencyKey: 'idem-race',
          orderId: 'order-race-b',
          pharmacyId: 'pharmacy-1',
          quantity: 1,
          dispensedByUserId: 'staff-1',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((rejected[0].reason as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    });
  });

  describe('transaction client (tx?: unknown) handling', () => {
    it('rolls back the dispense insert with the caller-supplied transaction', async () => {
      const line = await seedLine();
      await expect(
        prisma.$transaction(async (tx) => {
          await repo.create(
            {
              prescriptionLineId: line.id,
              idempotencyKey: 'idem-tx-1',
              orderId: 'order-tx-1',
              pharmacyId: 'pharmacy-1',
              quantity: 1,
              dispensedByUserId: 'staff-1',
            },
            tx,
          );
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      await expect(repo.findByIdempotencyKey(line.id, 'idem-tx-1')).resolves.toBeNull();
    });
  });
});
