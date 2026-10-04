import { PrismaFulfillmentRepository } from '../../src/modules/orders/infrastructure/persistence/prisma-fulfillment.repository';
import { PrismaOrderRepository } from '../../src/modules/orders/infrastructure/persistence/prisma-order.repository';
import { NewOrderData } from '../../src/modules/orders/domain/repositories/order.repository';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { createPrisma, resetOrdersTables } from './support';

function baseOrder(overrides: Partial<NewOrderData> = {}): NewOrderData {
  return {
    orderNumber: `ORD-${Math.random().toString(36).slice(2, 10)}`,
    customerUserId: 'customer-1',
    beneficiarySnapshot: null,
    addressSnapshot: null,
    status: 'PENDING_PAYMENT',
    subtotal: 1000,
    deliveryFee: 100,
    platformFee: 50,
    discountTotal: 0,
    grandTotal: 1150,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2, 10)}`,
    isCod: true,
    ...overrides,
  };
}

describe('PrismaFulfillmentRepository (e2e)', () => {
  let prisma: PrismaService;
  let repo: PrismaFulfillmentRepository;
  let orders: PrismaOrderRepository;

  beforeAll(async () => {
    prisma = await createPrisma();
    repo = new PrismaFulfillmentRepository(prisma);
    orders = new PrismaOrderRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetOrdersTables(prisma);
  });

  async function newOrder() {
    return orders.create(baseOrder(), { fromStatus: null, toStatus: 'PENDING_PAYMENT' });
  }

  describe('create / findById / findByOrderId', () => {
    it('creates the Slice-1 single fulfillment for an order, defaulting to PENDING (§3.6)', async () => {
      const order = await newOrder();
      const created = await repo.create({
        orderId: order.id,
        pharmacyId: 'pharmacy-1',
        branchId: 'branch-1',
      });

      expect(created.id).toEqual(expect.any(String));
      expect(created.orderId).toBe(order.id);
      expect(created.pharmacyId).toBe('pharmacy-1');
      expect(created.branchId).toBe('branch-1');
      expect(created.status).toBe('PENDING');
      expect(created.acceptedAt).toBeNull();
      expect(created.readyAt).toBeNull();

      const found = await repo.findById(created.id);
      expect(found).toEqual(created);

      const byOrder = await repo.findByOrderId(order.id);
      expect(byOrder).toEqual([created]);
    });

    it('returns null/[] for an unknown fulfillment/order id', async () => {
      await expect(repo.findById('00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
      await expect(repo.findByOrderId('00000000-0000-0000-0000-000000000000')).resolves.toEqual([]);
    });
  });

  describe('updateStatus', () => {
    it('persists the already-validated transition and its timestamp fields (§3.6, §9.4)', async () => {
      const order = await newOrder();
      const fulfillment = await repo.create({
        orderId: order.id,
        pharmacyId: 'pharmacy-2',
        branchId: 'branch-2',
      });

      const acceptedAt = new Date('2026-01-01T00:00:00.000Z');
      await repo.updateStatus(fulfillment.id, { status: 'ACCEPTED', acceptedAt });

      const afterAccept = await repo.findById(fulfillment.id);
      expect(afterAccept?.status).toBe('ACCEPTED');
      expect(afterAccept?.acceptedAt).toEqual(acceptedAt);

      const readyAt = new Date('2026-01-02T00:00:00.000Z');
      await repo.updateStatus(fulfillment.id, { status: 'READY', readyAt });

      const afterReady = await repo.findById(fulfillment.id);
      expect(afterReady?.status).toBe('READY');
      expect(afterReady?.readyAt).toEqual(readyAt);
      expect(afterReady?.acceptedAt).toEqual(acceptedAt); // untouched by the second update
    });
  });

  describe('listByPharmacyIds (§9.4 GET /pharmacy/orders)', () => {
    it('scopes to the caller-resolved pharmacyIds and paginates', async () => {
      const orderA = await newOrder();
      const orderB = await newOrder();
      const orderC = await newOrder();

      const fA = await repo.create({ orderId: orderA.id, pharmacyId: 'pharmacy-x', branchId: 'branch-x' });
      const fB = await repo.create({ orderId: orderB.id, pharmacyId: 'pharmacy-y', branchId: 'branch-y' });
      await repo.create({ orderId: orderC.id, pharmacyId: 'pharmacy-z', branchId: 'branch-z' }); // excluded

      const result = await repo.listByPharmacyIds({
        pharmacyIds: ['pharmacy-x', 'pharmacy-y'],
        page: 1,
        size: 10,
      });

      expect(result.total).toBe(2);
      expect(result.items.map((f) => f.id).sort()).toEqual([fA.id, fB.id].sort());
    });

    it('filters by status when provided', async () => {
      const orderA = await newOrder();
      const orderB = await newOrder();
      const fA = await repo.create({ orderId: orderA.id, pharmacyId: 'pharmacy-w', branchId: 'branch-w' });
      await repo.create({ orderId: orderB.id, pharmacyId: 'pharmacy-w', branchId: 'branch-w' });
      await repo.updateStatus(fA.id, { status: 'ACCEPTED' });

      const result = await repo.listByPharmacyIds({
        pharmacyIds: ['pharmacy-w'],
        status: 'ACCEPTED',
        page: 1,
        size: 10,
      });

      expect(result.total).toBe(1);
      expect(result.items[0].id).toBe(fA.id);
    });
  });

  describe('transaction client (tx?: unknown) handling', () => {
    it('participates in the caller-supplied transaction: a rollback discards the write', async () => {
      const order = await newOrder();
      let fulfillmentId: string | undefined;

      await expect(
        prisma.$transaction(async (tx) => {
          const created = await repo.create(
            { orderId: order.id, pharmacyId: 'pharmacy-tx', branchId: 'branch-tx' },
            tx,
          );
          fulfillmentId = created.id;
          const seenInTx = await repo.findById(created.id, tx);
          expect(seenInTx).not.toBeNull();
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      await expect(repo.findById(fulfillmentId!)).resolves.toBeNull();
    });

    it('commits normally when the transaction succeeds', async () => {
      const order = await newOrder();
      const fulfillmentId = await prisma.$transaction(async (tx) => {
        const created = await repo.create(
          { orderId: order.id, pharmacyId: 'pharmacy-tx-2', branchId: 'branch-tx-2' },
          tx,
        );
        await repo.updateStatus(created.id, { status: 'ACCEPTED' }, tx);
        return created.id;
      });

      const found = await repo.findById(fulfillmentId);
      expect(found?.status).toBe('ACCEPTED');
    });
  });
});
