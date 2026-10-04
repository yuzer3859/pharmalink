import { PrismaPrescriptionRepository } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-prescription.repository';
import { PrismaVerificationRepository } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-verification.repository';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { createPrisma, resetPrescriptionMatchingTables } from './support';

describe('PrismaVerificationRepository (e2e)', () => {
  let prisma: PrismaService;
  let repo: PrismaVerificationRepository;
  let prescriptions: PrismaPrescriptionRepository;

  beforeAll(async () => {
    prisma = await createPrisma();
    repo = new PrismaVerificationRepository(prisma);
    prescriptions = new PrismaPrescriptionRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetPrescriptionMatchingTables(prisma);
  });

  it('appends an APPROVED review and round-trips every field (§3.3)', async () => {
    const prescription = await prescriptions.create({ customerUserId: 'customer-1' });

    const review = await repo.create({
      prescriptionId: prescription.id,
      reviewerUserId: 'pharmacist-1',
      pharmacyId: 'pharmacy-1',
      decision: 'APPROVED',
      legibilityOk: true,
      validityOk: true,
    });

    expect(review.id).toEqual(expect.any(String));
    expect(review.prescriptionId).toBe(prescription.id);
    expect(review.reviewerUserId).toBe('pharmacist-1');
    expect(review.pharmacyId).toBe('pharmacy-1');
    expect(review.decision).toBe('APPROVED');
    expect(review.legibilityOk).toBe(true);
    expect(review.validityOk).toBe(true);
    expect(review.reason).toBeNull();
    expect(review.reviewedAt).toEqual(expect.any(Date));
  });

  it('appends a REJECTED review carrying the mandatory reason (BRULE-14)', async () => {
    const prescription = await prescriptions.create({ customerUserId: 'customer-2' });

    const review = await repo.create({
      prescriptionId: prescription.id,
      reviewerUserId: 'pharmacist-2',
      pharmacyId: 'pharmacy-2',
      decision: 'REJECTED',
      reason: 'Illegible handwriting',
    });

    expect(review.decision).toBe('REJECTED');
    expect(review.reason).toBe('Illegible handwriting');
  });

  it('accumulates multiple decisions over a prescription lifecycle and returns them in chronological order (§3.3)', async () => {
    const prescription = await prescriptions.create({ customerUserId: 'customer-3' });

    const clarification = await repo.create({
      prescriptionId: prescription.id,
      reviewerUserId: 'pharmacist-3',
      pharmacyId: 'pharmacy-3',
      decision: 'CLARIFICATION',
      reason: 'Please re-upload a legible copy',
    });
    const approval = await repo.create({
      prescriptionId: prescription.id,
      reviewerUserId: 'pharmacist-3',
      pharmacyId: 'pharmacy-3',
      decision: 'APPROVED',
      legibilityOk: true,
      validityOk: true,
    });

    const trail = await repo.listByPrescriptionId(prescription.id);
    expect(trail.map((r) => r.id)).toEqual([clarification.id, approval.id]);
    expect(trail.map((r) => r.decision)).toEqual(['CLARIFICATION', 'APPROVED']);
  });

  it('returns an empty trail for a prescription with no reviews yet', async () => {
    const prescription = await prescriptions.create({ customerUserId: 'customer-4' });
    await expect(repo.listByPrescriptionId(prescription.id)).resolves.toEqual([]);
  });

  it('participates in the caller-supplied transaction and rolls back with it', async () => {
    const prescription = await prescriptions.create({ customerUserId: 'customer-5' });
    await expect(
      prisma.$transaction(async (tx) => {
        await repo.create(
          {
            prescriptionId: prescription.id,
            reviewerUserId: 'pharmacist-5',
            decision: 'APPROVED',
          },
          tx,
        );
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    await expect(repo.listByPrescriptionId(prescription.id)).resolves.toEqual([]);
  });
});
