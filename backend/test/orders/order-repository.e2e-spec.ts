import { PrismaOrderRepository } from '../../src/modules/orders/infrastructure/persistence/prisma-order.repository';
import { NewOrderData } from '../../src/modules/orders/domain/repositories/order.repository';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { createPrisma, resetOrdersTables } from './support';

function baseOrder(overrides: Partial<NewOrderData> = {}): NewOrderData {
  return {
    orderNumber: `ORD-${Math.random().toString(36).slice(2, 10)}`,
    customerUserId: 'customer-1',
    beneficiarySnapshot: null,
    addressSnapshot: { line1: 'Bole Road', city: 'Addis Ababa' },
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

describe('PrismaOrderRepository (e2e)', () => {
  let prisma: PrismaService;
  let repo: PrismaOrderRepository;

  beforeAll(async () => {
    prisma = await createPrisma();
    repo = new PrismaOrderRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetOrdersTables(prisma);
  });

  describe('create / findById / findByOrderNumber', () => {
    it('creates the Order header and its initial OrderStatusHistory row atomically (§3.4, §3.11 invariant 3)', async () => {
      const data = baseOrder();
      const created = await repo.create(data, {
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
        event: 'checkout_submitted',
      });

      expect(created.id).toEqual(expect.any(String));
      expect(created.orderNumber).toBe(data.orderNumber);
      expect(created.status).toBe('PENDING_PAYMENT');
      expect(created.strategy).toBe('SINGLE');
      expect(created.currency).toBe('ETB');
      expect(created.isCod).toBe(true);
      expect(created.paymentId).toBeNull();
      expect(created.beneficiarySnapshot).toBeNull();
      expect(created.addressSnapshot).toEqual({ line1: 'Bole Road', city: 'Addis Ababa' });

      const found = await repo.findById(created.id);
      expect(found).toEqual(created);

      const byNumber = await repo.findByOrderNumber(data.orderNumber);
      expect(byNumber?.id).toBe(created.id);

      const history = await repo.findStatusHistory(created.id);
      expect(history).toHaveLength(1);
      expect(history[0].fromStatus).toBeNull();
      expect(history[0].toStatus).toBe('PENDING_PAYMENT');
      expect(history[0].event).toBe('checkout_submitted');
    });

    it('returns null for an unknown id/order number/idempotency key', async () => {
      await expect(repo.findById('00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
      await expect(repo.findByOrderNumber('NO-SUCH-ORDER')).resolves.toBeNull();
      await expect(repo.findByIdempotencyKey('no-such-key')).resolves.toBeNull();
    });
  });

  describe('findByIdempotencyKey (§4, §13.5 replay lookup)', () => {
    it('resolves the already-committed order by its idempotency key', async () => {
      const data = baseOrder({ idempotencyKey: 'idem-replay-1' });
      const created = await repo.create(data, { fromStatus: null, toStatus: 'PENDING_PAYMENT' });

      const found = await repo.findByIdempotencyKey('idem-replay-1');
      expect(found?.id).toBe(created.id);
    });

    it('enforces the DB-level unique constraint on idempotencyKey', async () => {
      const data = baseOrder({ idempotencyKey: 'idem-unique-1' });
      await repo.create(data, { fromStatus: null, toStatus: 'PENDING_PAYMENT' });

      await expect(
        repo.create(baseOrder({ idempotencyKey: 'idem-unique-1' }), {
          fromStatus: null,
          toStatus: 'PENDING_PAYMENT',
        }),
      ).rejects.toThrow();
    });

    it('resolves two truly concurrent creates with the same idempotencyKey to exactly one committed order (CheckoutCommand\'s race-handling relies on this)', async () => {
      const idempotencyKey = 'idem-concurrent-1';
      const results = await Promise.allSettled([
        repo.create(baseOrder({ idempotencyKey }), { fromStatus: null, toStatus: 'PENDING_PAYMENT' }),
        repo.create(baseOrder({ idempotencyKey }), { fromStatus: null, toStatus: 'PENDING_PAYMENT' }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = await repo.findByIdempotencyKey(idempotencyKey);
      expect(winner).not.toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('updates the Order status and appends exactly one history row in the same call (§3.11 invariant 3)', async () => {
      const created = await repo.create(baseOrder(), {
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
      });

      const placedAt = new Date('2026-01-01T00:00:00.000Z');
      await repo.updateStatus(
        created.id,
        { status: 'PAID', placedAt },
        { fromStatus: 'PENDING_PAYMENT', toStatus: 'PAID', event: 'cod_confirmed' },
      );

      const updated = await repo.findById(created.id);
      expect(updated?.status).toBe('PAID');
      expect(updated?.placedAt).toEqual(placedAt);

      const history = await repo.findStatusHistory(created.id);
      expect(history).toHaveLength(2);
      expect(history[1].fromStatus).toBe('PENDING_PAYMENT');
      expect(history[1].toStatus).toBe('PAID');
      expect(history[1].event).toBe('cod_confirmed');
    });

    it('records cancellation fields alongside the CANCELLED transition', async () => {
      const created = await repo.create(baseOrder(), {
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
      });
      const cancelledAt = new Date('2026-02-01T00:00:00.000Z');

      await repo.updateStatus(
        created.id,
        { status: 'CANCELLED', cancelledAt, cancelReason: 'Customer changed their mind' },
        { fromStatus: 'PENDING_PAYMENT', toStatus: 'CANCELLED', reason: 'Customer changed their mind' },
      );

      const updated = await repo.findById(created.id);
      expect(updated?.status).toBe('CANCELLED');
      expect(updated?.cancelledAt).toEqual(cancelledAt);
      expect(updated?.cancelReason).toBe('Customer changed their mind');
    });
  });

  describe('listByCustomer', () => {
    it('paginates and filters by owner and status', async () => {
      await repo.create(baseOrder({ customerUserId: 'customer-list-1' }), {
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
      });
      const second = await repo.create(baseOrder({ customerUserId: 'customer-list-1' }), {
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
      });
      await repo.updateStatus(
        second.id,
        { status: 'PAID' },
        { fromStatus: 'PENDING_PAYMENT', toStatus: 'PAID' },
      );
      await repo.create(baseOrder({ customerUserId: 'customer-list-2' }), {
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
      }); // different owner, excluded

      const all = await repo.listByCustomer({ customerUserId: 'customer-list-1', page: 1, size: 10 });
      expect(all.total).toBe(2);

      const paidOnly = await repo.listByCustomer({
        customerUserId: 'customer-list-1',
        status: 'PAID',
        page: 1,
        size: 10,
      });
      expect(paidOnly.total).toBe(1);
      expect(paidOnly.items[0].id).toBe(second.id);
    });
  });

  describe('order lines', () => {
    it('createLines inserts one row per line, preserving frozen price/product snapshots (§3.7)', async () => {
      const order = await repo.create(baseOrder(), { fromStatus: null, toStatus: 'PENDING_PAYMENT' });

      const lines = await repo.createLines(order.id, [
        {
          catalogProductId: 'product-1',
          productSnapshot: { name: 'Paracetamol 500mg' },
          quantity: 2,
          unitPrice: 500,
          lineTotal: 1000,
          fulfillmentId: null,
          pharmacyId: 'pharmacy-1',
          branchId: 'branch-1',
          reservationId: 'reservation-1',
          requiresRx: false,
        },
        {
          catalogProductId: 'product-2',
          quantity: 1,
          unitPrice: 300,
          lineTotal: 300,
          prescriptionLineId: 'prescription-line-1',
          requiresRx: true,
        },
      ]);

      expect(lines).toHaveLength(2);
      const first = lines.find((l) => l.catalogProductId === 'product-1');
      expect(first?.productSnapshot).toEqual({ name: 'Paracetamol 500mg' });
      expect(first?.pharmacyId).toBe('pharmacy-1');
      expect(first?.reservationId).toBe('reservation-1');
      expect(first?.lineStatus).toBe('PENDING');

      const second = lines.find((l) => l.catalogProductId === 'product-2');
      expect(second?.requiresRx).toBe(true);
      expect(second?.prescriptionLineId).toBe('prescription-line-1');
      expect(second?.productSnapshot).toBeNull();

      const found = await repo.findLinesByOrderId(order.id);
      expect(found).toHaveLength(2);
    });
  });

  describe('updateLineFulfillment (§9.4 decline -> re-match reassignment, BR-ORD-14)', () => {
    it('re-points an OrderLine at a new fulfillment/pharmacy/reservation', async () => {
      const order = await repo.create(baseOrder(), { fromStatus: null, toStatus: 'PENDING_PAYMENT' });
      const [line] = await repo.createLines(order.id, [
        {
          catalogProductId: 'product-1',
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
          fulfillmentId: null,
          pharmacyId: 'pharmacy-declined',
          branchId: 'branch-declined',
          reservationId: 'reservation-declined',
        },
      ]);
      // OrderLine.fulfillmentId is a real FK (unlike the plain-string pharmacyId/branchId
      // columns, per this file's own support.ts doc comment) — the re-matched Fulfillment row
      // must exist before a line can be re-pointed at it.
      const newFulfillment = await prisma.fulfillment.create({
        data: { orderId: order.id, pharmacyId: 'pharmacy-rematched', branchId: 'branch-rematched' },
      });

      await repo.updateLineFulfillment(line.id, {
        fulfillmentId: newFulfillment.id,
        pharmacyId: 'pharmacy-rematched',
        branchId: 'branch-rematched',
        reservationId: 'reservation-rematched',
      });

      const [updated] = await repo.findLinesByOrderId(order.id);
      expect(updated.fulfillmentId).toBe(newFulfillment.id);
      expect(updated.pharmacyId).toBe('pharmacy-rematched');
      expect(updated.branchId).toBe('branch-rematched');
      expect(updated.reservationId).toBe('reservation-rematched');
    });
  });

  describe('invoice', () => {
    it('creates and loads the data-only invoice row (§3.9 — pdfRef always null)', async () => {
      const order = await repo.create(baseOrder(), { fromStatus: null, toStatus: 'PENDING_PAYMENT' });

      const totals = {
        subtotal: 1000,
        deliveryFee: 100,
        platformFee: 50,
        discountTotal: 0,
        grandTotal: 1150,
        currency: 'ETB',
        lines: [{ catalogProductId: 'product-1', quantity: 2, unitPrice: 500, lineTotal: 1000 }],
      };
      const created = await repo.createInvoice(order.id, { invoiceNumber: 'INV-0001', totals });

      expect(created.orderId).toBe(order.id);
      expect(created.invoiceNumber).toBe('INV-0001');
      expect(created.pdfRef).toBeNull();
      expect(created.totals).toEqual(totals);

      const found = await repo.findInvoiceByOrderId(order.id);
      expect(found).toEqual(created);
    });

    it('returns null when no invoice exists yet for the order', async () => {
      const order = await repo.create(baseOrder(), { fromStatus: null, toStatus: 'PENDING_PAYMENT' });
      await expect(repo.findInvoiceByOrderId(order.id)).resolves.toBeNull();
    });

    it('enforces the 1:1 Order<->Invoice relationship via the unique orderId constraint', async () => {
      const order = await repo.create(baseOrder(), { fromStatus: null, toStatus: 'PENDING_PAYMENT' });
      await repo.createInvoice(order.id, { invoiceNumber: 'INV-0002', totals: { grandTotal: 100 } });

      await expect(
        repo.createInvoice(order.id, { invoiceNumber: 'INV-0003', totals: { grandTotal: 200 } }),
      ).rejects.toThrow();
    });
  });

  describe('transaction client (tx?: unknown) handling', () => {
    it('rolls back the order header + initial history row together on failure', async () => {
      let orderId: string | undefined;
      await expect(
        prisma.$transaction(async (tx) => {
          const created = await repo.create(
            baseOrder({ idempotencyKey: 'idem-tx-1' }),
            { fromStatus: null, toStatus: 'PENDING_PAYMENT' },
            tx,
          );
          orderId = created.id;
          const seenInTx = await repo.findStatusHistory(created.id, tx);
          expect(seenInTx).toHaveLength(1);
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      await expect(repo.findById(orderId!)).resolves.toBeNull();
      await expect(repo.findStatusHistory(orderId!)).resolves.toEqual([]);
    });

    it('rolls back an order-status update + its history row together on a later failure in the same transaction (§3.11 invariant 3)', async () => {
      const created = await repo.create(baseOrder({ idempotencyKey: 'idem-tx-2' }), {
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
      });

      await expect(
        prisma.$transaction(async (tx) => {
          await repo.updateStatus(
            created.id,
            { status: 'PAID' },
            { fromStatus: 'PENDING_PAYMENT', toStatus: 'PAID' },
            tx,
          );
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      const afterRollback = await repo.findById(created.id);
      expect(afterRollback?.status).toBe('PENDING_PAYMENT');
      const history = await repo.findStatusHistory(created.id);
      expect(history).toHaveLength(1); // only the initial row — the PAID transition never committed
    });

    it('commits the order + lines + invoice together when the transaction succeeds', async () => {
      const orderId = await prisma.$transaction(async (tx) => {
        const created = await repo.create(
          baseOrder({ idempotencyKey: 'idem-tx-3' }),
          { fromStatus: null, toStatus: 'PENDING_PAYMENT' },
          tx,
        );
        await repo.createLines(
          created.id,
          [{ catalogProductId: 'product-tx-1', quantity: 1, unitPrice: 100, lineTotal: 100 }],
          tx,
        );
        await repo.createInvoice(
          created.id,
          { invoiceNumber: 'INV-TX-1', totals: { grandTotal: 100 } },
          tx,
        );
        return created.id;
      });

      expect(await repo.findLinesByOrderId(orderId)).toHaveLength(1);
      expect(await repo.findInvoiceByOrderId(orderId)).not.toBeNull();
    });
  });
});
