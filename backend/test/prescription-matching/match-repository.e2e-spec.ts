import { PrismaMatchRepository } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-match.repository';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { createPrisma, resetPrescriptionMatchingTables } from './support';

describe('PrismaMatchRepository (e2e)', () => {
  let prisma: PrismaService;
  let repo: PrismaMatchRepository;

  beforeAll(async () => {
    prisma = await createPrisma();
    repo = new PrismaMatchRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetPrescriptionMatchingTables(prisma);
  });

  describe('createWithCandidates / findById / listCandidates', () => {
    it('inserts the MatchRequest header and its ranked candidates in one call (§12 "Find match")', async () => {
      const { matchRequest, candidates } = await repo.createWithCandidates(
        { customerUserId: 'customer-1', strategy: 'SINGLE', deliveryLat: 9.03, deliveryLng: 38.74 },
        [
          { pharmacyId: 'pharmacy-1', branchId: 'branch-1', coverage: 'ALL', totalPrice: 1200, distanceMeters: 500, rank: 1 },
          { pharmacyId: 'pharmacy-2', branchId: 'branch-2', coverage: 'ALL', totalPrice: 1100, distanceMeters: 900, rank: 2 },
        ],
      );

      expect(matchRequest.id).toEqual(expect.any(String));
      expect(matchRequest.customerUserId).toBe('customer-1');
      expect(matchRequest.status).toBe('PENDING');
      expect(matchRequest.strategy).toBe('SINGLE');
      expect(matchRequest.deliveryLat).toBe(9.03);
      expect(matchRequest.deliveryLng).toBe(38.74);
      expect(matchRequest.chosenResult).toBeNull();
      expect(matchRequest.orderId).toBeNull();

      expect(candidates).toHaveLength(2);
      expect(candidates.every((c) => c.matchRequestId === matchRequest.id)).toBe(true);
      // rating/ratingCount are never written by Slice 1 (§0.2/§3.7) — always null.
      expect(candidates.every((c) => c.rating === null)).toBe(true);

      const found = await repo.findById(matchRequest.id);
      expect(found).toEqual(matchRequest);

      const listed = await repo.listCandidates(matchRequest.id);
      expect(listed.map((c) => c.pharmacyId)).toEqual(['pharmacy-1', 'pharmacy-2']); // rank asc
    });

    it('defaults orderId/deliveryLat/deliveryLng/strategy when omitted', async () => {
      const { matchRequest } = await repo.createWithCandidates(
        { customerUserId: 'customer-2', strategy: 'SINGLE' },
        [],
      );
      expect(matchRequest.orderId).toBeNull();
      expect(matchRequest.deliveryLat).toBeNull();
      expect(matchRequest.deliveryLng).toBeNull();
    });

    it('returns null from findById for an unknown id', async () => {
      await expect(repo.findById('00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
    });

    it('listCandidates returns an empty array for a match request with no candidates (NO_PHARMACY_MATCH case)', async () => {
      const { matchRequest } = await repo.createWithCandidates(
        { customerUserId: 'customer-3', strategy: 'SINGLE' },
        [],
      );
      await expect(repo.listCandidates(matchRequest.id)).resolves.toEqual([]);
    });
  });

  describe('updateStatus', () => {
    it('transitions status and writes chosenResult (§8.3 "Select match")', async () => {
      const { matchRequest } = await repo.createWithCandidates(
        { customerUserId: 'customer-4', strategy: 'SINGLE' },
        [{ pharmacyId: 'pharmacy-1', branchId: 'branch-1', coverage: 'ALL', totalPrice: 1000, rank: 1 }],
      );

      const chosenResult = {
        pharmacyId: 'pharmacy-1',
        branchId: 'branch-1',
        lines: [{ catalogProductId: 'product-1', listingId: 'listing-1', reservationId: 'res-1', quantity: 2 }],
      };

      await repo.updateStatus(matchRequest.id, { status: 'MATCHED', chosenResult });

      const updated = await repo.findById(matchRequest.id);
      expect(updated?.status).toBe('MATCHED');
      expect(updated?.chosenResult).toEqual(chosenResult);
    });

    it('records an explicit customer override pharmacyId (BR-MT-03)', async () => {
      const { matchRequest } = await repo.createWithCandidates(
        { customerUserId: 'customer-5', strategy: 'SINGLE' },
        [],
      );
      await repo.updateStatus(matchRequest.id, { status: 'MATCHED', overridePharmacyId: 'pharmacy-override' });
      const updated = await repo.findById(matchRequest.id);
      expect(updated?.overridePharmacyId).toBe('pharmacy-override');
    });

    it('explicitly clears chosenResult back to null (e.g. on a failed rematch)', async () => {
      const { matchRequest } = await repo.createWithCandidates(
        { customerUserId: 'customer-6', strategy: 'SINGLE' },
        [],
      );
      const chosenResult = {
        pharmacyId: 'pharmacy-1',
        branchId: 'branch-1',
        lines: [],
      };
      await repo.updateStatus(matchRequest.id, { status: 'MATCHED', chosenResult });
      await repo.updateStatus(matchRequest.id, { status: 'FAILED', chosenResult: null });

      const updated = await repo.findById(matchRequest.id);
      expect(updated?.status).toBe('FAILED');
      expect(updated?.chosenResult).toBeNull();
    });

    it('leaves chosenResult untouched when the caller omits it entirely', async () => {
      const { matchRequest } = await repo.createWithCandidates(
        { customerUserId: 'customer-7', strategy: 'SINGLE' },
        [],
      );
      const chosenResult = { pharmacyId: 'pharmacy-1', branchId: 'branch-1', lines: [] };
      await repo.updateStatus(matchRequest.id, { status: 'MATCHED', chosenResult });

      await repo.updateStatus(matchRequest.id, { status: 'REMATCHING' });

      const updated = await repo.findById(matchRequest.id);
      expect(updated?.status).toBe('REMATCHING');
      expect(updated?.chosenResult).toEqual(chosenResult);
    });
  });

  describe('replaceCandidates', () => {
    it('replaces the candidate set for a re-rank pass and scopes the delete to this match request (§8.4 RematchOrchestrator)', async () => {
      const { matchRequest: target } = await repo.createWithCandidates(
        { customerUserId: 'customer-8', strategy: 'SINGLE' },
        [
          { pharmacyId: 'pharmacy-declined', branchId: 'branch-1', coverage: 'ALL', totalPrice: 1000, rank: 1 },
          { pharmacyId: 'pharmacy-2', branchId: 'branch-2', coverage: 'ALL', totalPrice: 1100, rank: 2 },
        ],
      );
      const { matchRequest: other, candidates: otherCandidates } = await repo.createWithCandidates(
        { customerUserId: 'customer-9', strategy: 'SINGLE' },
        [{ pharmacyId: 'pharmacy-3', branchId: 'branch-3', coverage: 'ALL', totalPrice: 900, rank: 1 }],
      );

      const replaced = await repo.replaceCandidates(target.id, [
        { pharmacyId: 'pharmacy-2', branchId: 'branch-2', coverage: 'ALL', totalPrice: 1100, rank: 1 },
      ]);

      expect(replaced).toHaveLength(1);
      expect(replaced[0].pharmacyId).toBe('pharmacy-2');

      const targetCandidates = await repo.listCandidates(target.id);
      expect(targetCandidates.map((c) => c.pharmacyId)).toEqual(['pharmacy-2']);

      // The unrelated match request's candidates must be untouched.
      const untouched = await repo.listCandidates(other.id);
      expect(untouched.map((c) => c.id)).toEqual(otherCandidates.map((c) => c.id));
    });

    it('can replace with an empty set (MATCH_FAILED — no candidates remain)', async () => {
      const { matchRequest } = await repo.createWithCandidates(
        { customerUserId: 'customer-10', strategy: 'SINGLE' },
        [{ pharmacyId: 'pharmacy-1', branchId: 'branch-1', coverage: 'ALL', totalPrice: 1000, rank: 1 }],
      );
      const replaced = await repo.replaceCandidates(matchRequest.id, []);
      expect(replaced).toEqual([]);
      await expect(repo.listCandidates(matchRequest.id)).resolves.toEqual([]);
    });
  });

  describe('transaction client (tx?: unknown) handling', () => {
    it('rolls back both the header and candidate inserts together with the caller-supplied transaction', async () => {
      let matchRequestId: string | undefined;
      await expect(
        prisma.$transaction(async (tx) => {
          const { matchRequest } = await repo.createWithCandidates(
            { customerUserId: 'customer-tx-1', strategy: 'SINGLE' },
            [{ pharmacyId: 'pharmacy-1', branchId: 'branch-1', coverage: 'ALL', totalPrice: 1000, rank: 1 }],
            tx,
          );
          matchRequestId = matchRequest.id;
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      await expect(repo.findById(matchRequestId!)).resolves.toBeNull();
    });
  });
});
