import { Payment } from '../../src/modules/payment/domain/entities/payment.entity';
import { PaymentMethod, PaymentStatus } from '../../src/modules/payment/domain/enums';
import { NewPaymentData } from '../../src/modules/payment/domain/repositories/payment.repository';
import { FxRate } from '../../src/modules/payment/domain/value-objects/fx-rate.vo';
import { Money } from '../../src/modules/payment/domain/value-objects/money.vo';
import { PrismaPaymentRepository } from '../../src/modules/payment/infrastructure/persistence/prisma-payment.repository';
import { PrismaUnitOfWork } from '../../src/modules/payment/infrastructure/persistence/prisma-unit-of-work';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { createPrisma, resetPaymentTables, uniqueRef } from './support';

function newPayment(overrides: Partial<NewPaymentData> = {}): NewPaymentData {
  const payment = Payment.initiate(crypto.randomUUID(), {
    orderId: 'order-1',
    customerUserId: 'customer-1',
    method: PaymentMethod.TELEBIRR,
    amount: Money.base(11_500),
    idempotencyKey: uniqueRef('pay-idem'),
  });
  const props = payment.toProps();

  return {
    id: props.id,
    orderId: props.orderId,
    customerUserId: props.customerUserId,
    method: props.method,
    status: props.status,
    amount: props.amount,
    currency: props.currency,
    originalAmount: props.originalAmount,
    originalCurrency: props.originalCurrency,
    fxRate: props.fxRate,
    fxSource: props.fxSource,
    provider: props.provider,
    providerRef: props.providerRef,
    providerToken: props.providerToken,
    idempotencyKey: props.idempotencyKey,
    ...overrides,
  };
}

describe('PrismaPaymentRepository (e2e)', () => {
  let prisma: PrismaService;
  let repo: PrismaPaymentRepository;
  let uow: PrismaUnitOfWork;

  beforeAll(async () => {
    prisma = await createPrisma();
    repo = new PrismaPaymentRepository(prisma);
    uow = new PrismaUnitOfWork(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetPaymentTables(prisma);
  });

  describe('create / find', () => {
    it('persists an INITIATED payment and reads it back verbatim', async () => {
      const data = newPayment();
      const created = await repo.create(data);

      expect(created.id).toBe(data.id);
      expect(created.status).toBe(PaymentStatus.INITIATED);
      expect(created.amount).toBe(11_500);
      expect(created.currency).toBe('ETB');
      expect(created.method).toBe(PaymentMethod.TELEBIRR);
      expect(created.authorizedAt).toBeNull();
      expect(created.capturedAt).toBeNull();
      expect(created.failureReason).toBeNull();
      expect(created.originalAmount).toBeNull();
      expect(created.fxRate).toBeNull();

      await expect(repo.findById(created.id)).resolves.toEqual(created);
      await expect(
        repo.findById('00000000-0000-0000-0000-000000000000'),
      ).resolves.toBeNull();
    });

    it('lists every attempt made against one order, oldest first', async () => {
      const failed = await repo.create(newPayment({ orderId: 'order-multi' }));
      await repo.updateState(failed.id, {
        status: PaymentStatus.FAILED,
        failureReason: 'gateway timeout',
      });
      const retried = await repo.create(newPayment({ orderId: 'order-multi' }));
      await repo.create(newPayment({ orderId: 'order-other' }));

      const attempts = await repo.findByOrderId('order-multi');
      expect(attempts.map((payment) => payment.id)).toEqual([failed.id, retried.id]);
      expect(attempts[0].status).toBe(PaymentStatus.FAILED);
      expect(attempts[1].status).toBe(PaymentStatus.INITIATED);
    });

    it('persists a cross-border payment with its original amount, currency and rate (§8)', async () => {
      const payment = Payment.initiate(crypto.randomUUID(), {
        orderId: 'order-diaspora',
        customerUserId: 'customer-diaspora',
        method: PaymentMethod.CROSS_BORDER,
        fx: {
          originalAmount: Money.of(1_000, 'USD'),
          rate: FxRate.of({
            rate: 57.5,
            source: 'nbe-daily',
            capturedAt: new Date('2026-09-08T00:00:00.000Z'),
          }),
        },
        idempotencyKey: uniqueRef('pay-fx'),
      });
      const props = payment.toProps();

      const created = await repo.create({
        id: props.id,
        orderId: props.orderId,
        customerUserId: props.customerUserId,
        method: props.method,
        status: props.status,
        amount: props.amount,
        currency: props.currency,
        originalAmount: props.originalAmount,
        originalCurrency: props.originalCurrency,
        fxRate: props.fxRate,
        fxSource: props.fxSource,
        idempotencyKey: props.idempotencyKey,
      });

      expect(created.amount).toBe(57_500);
      expect(created.currency).toBe('ETB');
      expect(created.originalAmount).toBe(1_000);
      expect(created.originalCurrency).toBe('USD');
      expect(created.fxRate).toBe(57.5);
      expect(created.fxSource).toBe('nbe-daily');
    });
  });

  describe('idempotency (BRULE-25)', () => {
    it('resolves an already-committed payment by its idempotency key', async () => {
      const created = await repo.create(newPayment({ idempotencyKey: 'pay-idem-replay-1' }));

      await expect(repo.findByIdempotencyKey('pay-idem-replay-1')).resolves.toMatchObject({
        id: created.id,
      });
      await expect(repo.findByIdempotencyKey('no-such-key-at-all')).resolves.toBeNull();
    });

    it('enforces the DB-level unique constraint on idempotencyKey', async () => {
      await repo.create(newPayment({ idempotencyKey: 'pay-idem-unique-1' }));

      await expect(
        repo.create(newPayment({ idempotencyKey: 'pay-idem-unique-1' })),
      ).rejects.toMatchObject({ code: 'P2002' });

      await expect(prisma.payment.count()).resolves.toBe(1);
    });

    it('resolves two truly concurrent creates with the same key to exactly one payment', async () => {
      const idempotencyKey = 'pay-idem-concurrent-1';
      const results = await Promise.allSettled([
        repo.create(newPayment({ idempotencyKey })),
        repo.create(newPayment({ idempotencyKey })),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      await expect(prisma.payment.count({ where: { idempotencyKey } })).resolves.toBe(1);
      await expect(repo.findByIdempotencyKey(idempotencyKey)).resolves.not.toBeNull();
    });

    it('the same key is still rejected across separate orders and customers (one key, one payment)', async () => {
      await repo.create(
        newPayment({ idempotencyKey: 'pay-idem-cross-1', orderId: 'order-a', customerUserId: 'a' }),
      );

      await expect(
        repo.create(
          newPayment({
            idempotencyKey: 'pay-idem-cross-1',
            orderId: 'order-b',
            customerUserId: 'b',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('updateState — persists an already-validated transition (§6)', () => {
    it('writes the authorize transition with its timestamp and provider reference', async () => {
      const created = await repo.create(newPayment());
      const payment = Payment.rehydrate(created);
      const authorizedAt = new Date('2026-09-08T10:00:00.000Z');
      payment.authorize(authorizedAt, 'telebirr-ref-1');

      const updated = await repo.updateState(created.id, {
        status: payment.status,
        authorizedAt: payment.authorizedAt,
        providerRef: payment.providerRef,
      });

      expect(updated.status).toBe(PaymentStatus.AUTHORIZED);
      expect(updated.authorizedAt).toEqual(authorizedAt);
      expect(updated.providerRef).toBe('telebirr-ref-1');
      expect(updated.capturedAt).toBeNull();
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    });

    it('walks a payment through INITIATED -> AUTHORIZED -> CAPTURED -> SETTLED', async () => {
      const created = await repo.create(newPayment());
      const payment = Payment.rehydrate(created);
      const authorizedAt = new Date('2026-09-08T10:00:00.000Z');
      const capturedAt = new Date('2026-09-08T12:00:00.000Z');

      payment.authorize(authorizedAt);
      await repo.updateState(created.id, {
        status: payment.status,
        authorizedAt: payment.authorizedAt,
      });

      payment.capture(capturedAt, 'telebirr-capture-1');
      await repo.updateState(created.id, {
        status: payment.status,
        capturedAt: payment.capturedAt,
        providerRef: payment.providerRef,
      });

      payment.settle();
      const settled = await repo.updateState(created.id, { status: payment.status });

      expect(settled.status).toBe(PaymentStatus.SETTLED);
      expect(settled.authorizedAt).toEqual(authorizedAt);
      expect(settled.capturedAt).toEqual(capturedAt);
      expect(settled.providerRef).toBe('telebirr-capture-1');
    });

    it('records a failure reason', async () => {
      const created = await repo.create(newPayment());
      const updated = await repo.updateState(created.id, {
        status: PaymentStatus.FAILED,
        failureReason: 'Insufficient funds at provider',
      });

      expect(updated.status).toBe(PaymentStatus.FAILED);
      expect(updated.failureReason).toBe('Insufficient funds at provider');
    });

    it('rolls back with the caller transaction', async () => {
      const created = await repo.create(newPayment());

      await expect(
        uow.run(async (tx) => {
          await repo.updateState(created.id, { status: PaymentStatus.AUTHORIZED }, tx);
          throw new Error('command failed after the state change');
        }),
      ).rejects.toThrow('command failed after the state change');

      await expect(repo.findById(created.id)).resolves.toMatchObject({
        status: PaymentStatus.INITIATED,
      });
    });
  });

  describe('database-level invariants', () => {
    it('rejects a non-positive amount (payments_amount_positive_check)', async () => {
      for (const amount of [0, -1]) {
        await expect(repo.create(newPayment({ amount }))).rejects.toThrow();
      }
      await expect(prisma.payment.count()).resolves.toBe(0);
    });

    it('rejects a partial FX triple (payments_fx_triple_check)', async () => {
      await expect(
        repo.create(newPayment({ originalAmount: 1_000, originalCurrency: null, fxRate: null })),
      ).rejects.toThrow();
      await expect(
        repo.create(newPayment({ originalAmount: 1_000, originalCurrency: 'USD', fxRate: null })),
      ).rejects.toThrow();
      await expect(
        repo.create(newPayment({ originalAmount: 1_000, originalCurrency: 'USD', fxRate: 0 })),
      ).rejects.toThrow();
      await expect(prisma.payment.count()).resolves.toBe(0);
    });

    it('accepts a complete FX triple', async () => {
      await expect(
        repo.create(
          newPayment({
            originalAmount: 1_000,
            originalCurrency: 'USD',
            fxRate: 57.5,
            fxSource: 'nbe-daily',
          }),
        ),
      ).resolves.toMatchObject({ originalCurrency: 'USD' });
    });

    it('stores every §6 status value', async () => {
      for (const status of Object.values(PaymentStatus)) {
        const created = await repo.create(newPayment({ status }));
        expect(created.status).toBe(status);
      }
      await expect(prisma.payment.count()).resolves.toBe(9);
    });
  });

  describe('PCI boundary (BRULE-26, NFR-SEC-04)', () => {
    it('the payments table has no card-data column', async () => {
      const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'payments'
      `;
      const names = columns.map((column) => column.column_name.toLowerCase());

      for (const forbidden of [
        'pan',
        'cardnumber',
        'card_number',
        'cvv',
        'cvc',
        'expiry',
        'cardholder',
        'cardholdername',
      ]) {
        expect(names).not.toContain(forbidden);
      }
      expect(names).toEqual(expect.arrayContaining(['providerref', 'providertoken']));
    });

    it('stores only an opaque provider token, never card data', async () => {
      const created = await repo.create(
        newPayment({ provider: 'telebirr', providerToken: 'tok_opaque_gateway_reference' }),
      );

      expect(created.providerToken).toBe('tok_opaque_gateway_reference');
      expect(created.provider).toBe('telebirr');
      expect(Object.keys(created)).not.toContain('pan');
      expect(Object.keys(created)).not.toContain('cvv');
    });
  });
});
