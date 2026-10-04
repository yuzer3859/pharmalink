import { randomUUID } from 'crypto';
import request from 'supertest';
import { AuthorizePaymentCommand } from '../../src/modules/payment/application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../src/modules/payment/application/commands/capture-payment.command';
import {
  RefundInitiator,
  RefundPaymentCommand,
} from '../../src/modules/payment/application/commands/refund-payment.command';
import { SpendWalletCommand } from '../../src/modules/payment/application/commands/spend-wallet.command';
import { TopUpWalletCommand } from '../../src/modules/payment/application/commands/top-up-wallet.command';
import {
  IWalletPort,
  WALLET_PORT,
} from '../../src/modules/payment/application/ports/inbound/wallet.port';
import { WalletAccountingService } from '../../src/modules/payment/application/services/wallet-accounting.service';
import {
  LedgerAccountType,
  LedgerDirection,
  PaymentMethod,
  RefundDestination,
} from '../../src/modules/payment/domain/enums';
import { ApiException } from '../../src/shared/errors/api-exception';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, login } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * The wallet against real PostgreSQL (§3.3, §9.4, §11.6).
 *
 * Nothing is substituted: real `AppModule` wiring, real commands, real Prisma repositories, real
 * `Serializable` transactions, the real immutable ledger with its append-only triggers, the real
 * global guards and `ValidationPipe`, and real PostgreSQL. That matters more here than anywhere
 * else in the wallet, because "two concurrent spends cannot share the same last funds" is enforced
 * by PostgreSQL's serializable snapshot isolation — a test against an in-memory double could not
 * observe whether it actually holds.
 *
 * `MockPaymentProvider` is the shipped gateway stand-in and performs no network I/O. Telebirr is
 * never reached: it is unavailable by construction and refuses every operation.
 */
describe('Wallet (e2e)', () => {
  let ctx: TestContext;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let refund: RefundPaymentCommand;
  let topUp: TopUpWalletCommand;
  let spend: SpendWalletCommand;
  let wallets: WalletAccountingService;
  let walletPort: IWalletPort;

  beforeAll(async () => {
    ctx = await createTestApp();
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
    refund = ctx.app.get(RefundPaymentCommand);
    topUp = ctx.app.get(TopUpWalletCommand);
    spend = ctx.app.get(SpendWalletCommand);
    wallets = ctx.app.get(WalletAccountingService);
    walletPort = ctx.app.get(WALLET_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------

  async function seedOrder(customerUserId: string, grandTotal: number, platformFee = 0) {
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId,
        status: 'PENDING_PAYMENT',
        subtotal: grandTotal - platformFee,
        deliveryFee: 0,
        platformFee,
        discountTotal: 0,
        grandTotal,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: false,
      },
    });
    await ctx.prisma.fulfillment.create({
      data: {
        orderId: order.id,
        pharmacyId: `pharmacy-${randomUUID()}`,
        branchId: `branch-${randomUUID()}`,
      },
    });
    return order;
  }

  /**
   * A payment that has genuinely collected money and has **not** been allocated to a provider —
   * the shape a wallet top-up is funded by. Authorization goes through the real command and the
   * real gateway stand-in; the `CAPTURED` transition is applied directly because
   * `CapturePaymentCommand` would also post `CAPTURE-<paymentId>`, routing the gross to a
   * pharmacy instead. That an order-less payment path does not exist yet is exactly the gap
   * `TopUpWalletCommand` documents.
   */
  async function fundingPayment(customerUserId: string, amount: number) {
    const order = await seedOrder(customerUserId, amount);
    const authorized = await authorize.execute({
      customerUserId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    await ctx.prisma.payment.update({
      where: { id: authorized.paymentId },
      data: { status: 'CAPTURED', capturedAt: new Date() },
    });
    return { paymentId: authorized.paymentId, orderId: order.id, amount };
  }

  /** Puts real money in a wallet, through the real top-up command. */
  async function fundWallet(customerUserId: string, amount: number) {
    const payment = await fundingPayment(customerUserId, amount);
    await topUp.execute({
      customerUserId,
      paymentId: payment.paymentId,
      idempotencyKey: `wallet-topup-${randomUUID()}`,
    });
    return payment;
  }

  async function balanceOf(customerUserId: string): Promise<number> {
    return (await wallets.balanceOf(customerUserId, 'ETB')).amountMinor;
  }

  /** The balance recomputed straight off `ledger_entries` in SQL — the ledger's own answer. */
  async function balanceFromEntries(customerUserId: string): Promise<number> {
    const account = await ctx.prisma.ledgerAccount.findFirstOrThrow({
      where: { type: 'CUSTOMER_WALLET', ownerId: customerUserId, currency: 'ETB' },
    });
    const rows = await ctx.prisma.ledgerEntry.findMany({ where: { accountId: account.id } });
    return rows.reduce(
      (total, row) => total + (row.direction === LedgerDirection.CREDIT ? row.amount : -row.amount),
      0,
    );
  }

  // ===========================================================================================
  // Account resolution and derived balance
  // ===========================================================================================

  it('opens the wallet ledger account on first use, and only once', async () => {
    const customerUserId = `customer-${randomUUID()}`;

    const first = await wallets.resolveWalletAccount(customerUserId, 'ETB');
    const second = await wallets.resolveWalletAccount(customerUserId, 'ETB');

    expect(second.id).toBe(first.id);
    expect(
      await ctx.prisma.ledgerAccount.count({
        where: { type: 'CUSTOMER_WALLET', ownerId: customerUserId },
      }),
    ).toBe(1);
    // The natural key is exactly §7's unique index — no wallet table, no balance column.
    expect(first).toMatchObject({
      type: LedgerAccountType.CUSTOMER_WALLET,
      ownerId: customerUserId,
      currency: 'ETB',
    });
  });

  it('derives the balance from ledger entries, matching a raw SQL recomputation', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);
    await spend.execute({
      customerUserId,
      orderId: (await seedOrder(customerUserId, 400)).id,
      amount: 400,
      idempotencyKey: `wallet-spend-${randomUUID()}`,
    });

    expect(await balanceOf(customerUserId)).toBe(600);
    expect(await balanceFromEntries(customerUserId)).toBe(600);
  });

  it('does not trust the account_balances cache as the source of truth', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);
    const account = await ctx.prisma.ledgerAccount.findFirstOrThrow({
      where: { type: 'CUSTOMER_WALLET', ownerId: customerUserId },
    });
    // The cache is rebuildable and here deliberately wrong. A wallet that read it would agree.
    await ctx.prisma.accountBalance.update({
      where: { accountId: account.id },
      data: { balance: 999_999 },
    });

    expect(await balanceOf(customerUserId)).toBe(1_000);
    expect((await walletPort.balance(customerUserId)).balance).toBe(1_000);
  });

  /** §13's worked example against real PostgreSQL: +1000 top-up, +200 refund, −400 spend = 800. */
  it('accumulates top-up, refund and spend into one derived balance', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);

    // A real refund with destination = WALLET, through the untouched refund command.
    const order = await seedOrder(customerUserId, 200);
    const authorized = await authorize.execute({
      customerUserId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    await capture.execute({ paymentId: authorized.paymentId });
    await refund.execute({
      paymentId: authorized.paymentId,
      amount: 200,
      destination: RefundDestination.WALLET,
      idempotencyKey: `refund-${randomUUID()}`,
      initiator: RefundInitiator.SYSTEM,
    });

    await spend.execute({
      customerUserId,
      orderId: (await seedOrder(customerUserId, 400)).id,
      amount: 400,
      idempotencyKey: `wallet-spend-${randomUUID()}`,
    });

    expect(await balanceOf(customerUserId)).toBe(800);
    expect(await balanceFromEntries(customerUserId)).toBe(800);
  });

  // ===========================================================================================
  // Top-up
  // ===========================================================================================

  it('posts a balanced top-up transaction with the deterministic reference', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    const payment = await fundingPayment(customerUserId, 1_000);

    const result = await topUp.execute({
      customerUserId,
      paymentId: payment.paymentId,
      idempotencyKey: `wallet-topup-${randomUUID()}`,
    });

    expect(result).toMatchObject({
      amount: 1_000,
      currency: 'ETB',
      ledgerReference: `WALLET-TOPUP-${payment.paymentId}`,
      balance: 1_000,
      replay: false,
    });

    const posting = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `WALLET-TOPUP-${payment.paymentId}` },
      include: { entries: { include: { account: true } } },
    });
    expect(posting.type).toBe('WALLET_TOPUP');
    expect(posting.refType).toBe('payment');
    expect(posting.refId).toBe(payment.paymentId);
    const debit = posting.entries.filter((e) => e.direction === LedgerDirection.DEBIT);
    const credit = posting.entries.filter((e) => e.direction === LedgerDirection.CREDIT);
    expect(debit.reduce((t, e) => t + e.amount, 0)).toBe(1_000);
    expect(credit.reduce((t, e) => t + e.amount, 0)).toBe(1_000);
    // The credit is backed: money left gateway clearing and entered the wallet.
    expect(debit[0].account.type).toBe('GATEWAY_CLEARING');
    expect(credit[0].account.type).toBe('CUSTOMER_WALLET');
    expect(credit[0].account.ownerId).toBe(customerUserId);
    expect(new Set(posting.entries.map((e) => e.currency))).toEqual(new Set(['ETB']));
  });

  it('never credits twice, however many times the same top-up is replayed', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    const payment = await fundingPayment(customerUserId, 1_000);
    const request = {
      customerUserId,
      paymentId: payment.paymentId,
      idempotencyKey: `wallet-topup-${randomUUID()}`,
    };
    await topUp.execute(request);

    const replay = await topUp.execute(request);

    expect(replay.replay).toBe(true);
    expect(await balanceOf(customerUserId)).toBe(1_000);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'WALLET_TOPUP' } })).toBe(1);
  });

  it('collapses two concurrent top-ups of the same payment into one credit', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    const payment = await fundingPayment(customerUserId, 1_000);

    const results = await Promise.allSettled([
      topUp.execute({
        customerUserId,
        paymentId: payment.paymentId,
        idempotencyKey: `wallet-topup-a-${randomUUID()}`,
      }),
      topUp.execute({
        customerUserId,
        paymentId: payment.paymentId,
        idempotencyKey: `wallet-topup-b-${randomUUID()}`,
      }),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await balanceOf(customerUserId)).toBe(1_000);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'WALLET_TOPUP' } })).toBe(1);
  });

  it('refuses to credit from a payment that was never captured', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    const order = await seedOrder(customerUserId, 1_000);
    const authorized = await authorize.execute({
      customerUserId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });

    await expect(
      topUp.execute({
        customerUserId,
        paymentId: authorized.paymentId,
        idempotencyKey: `wallet-topup-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(ApiException);

    expect(await balanceOf(customerUserId)).toBe(0);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'WALLET_TOPUP' } })).toBe(0);
  });

  it("refuses to credit from a payment whose funds already went to a pharmacy", async () => {
    const customerUserId = `customer-${randomUUID()}`;
    const order = await seedOrder(customerUserId, 1_000, 100);
    const authorized = await authorize.execute({
      customerUserId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    // A real capture: the gross is now owed to the pharmacy and to platform revenue.
    await capture.execute({ paymentId: authorized.paymentId });

    await expect(
      topUp.execute({
        customerUserId,
        paymentId: authorized.paymentId,
        idempotencyKey: `wallet-topup-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(ApiException);

    expect(await balanceOf(customerUserId)).toBe(0);
  });

  // ===========================================================================================
  // Spend
  // ===========================================================================================

  it('posts a balanced spend transaction: DEBIT wallet, CREDIT gateway clearing', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);
    const order = await seedOrder(customerUserId, 400);

    const result = await spend.execute({
      customerUserId,
      orderId: order.id,
      amount: 400,
      idempotencyKey: `wallet-spend-${randomUUID()}`,
    });

    expect(result).toMatchObject({
      ledgerReference: `WALLET-SPEND-${order.id}`,
      amount: 400,
      balance: 600,
      replay: false,
    });

    const posting = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `WALLET-SPEND-${order.id}` },
      include: { entries: { include: { account: true } } },
    });
    expect(posting.type).toBe('WALLET_SPEND');
    expect(posting.refType).toBe('order');
    expect(posting.refId).toBe(order.id);
    const debit = posting.entries.find((e) => e.direction === LedgerDirection.DEBIT)!;
    const credit = posting.entries.find((e) => e.direction === LedgerDirection.CREDIT)!;
    expect(debit.account.type).toBe('CUSTOMER_WALLET');
    expect(debit.account.ownerId).toBe(customerUserId);
    expect(credit.account.type).toBe('GATEWAY_CLEARING');
    expect(debit.amount).toBe(credit.amount);
  });

  it('refuses a spend the wallet cannot fund and writes nothing', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);
    const order = await seedOrder(customerUserId, 1_001);

    await expect(
      spend.execute({
        customerUserId,
        orderId: order.id,
        amount: 1_001,
        idempotencyKey: `wallet-spend-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_WALLET_BALANCE });

    expect(await balanceOf(customerUserId)).toBe(1_000);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'WALLET_SPEND' } })).toBe(0);
  });

  /**
   * §9's required race, against real PostgreSQL. Balance 1000, two simultaneous spends of 700.
   *
   * Exactly one may commit. The loser either reads the winner's debit and refuses with
   * `INSUFFICIENT_WALLET_BALANCE`, or is aborted by SSI and refuses after `runWithPaymentRetry`
   * re-runs it — both are correct outcomes and which one occurs is PostgreSQL's choice, not ours.
   * What is never acceptable is two commits or a negative balance.
   */
  it('lets exactly one of two concurrent 700 spends succeed against a 1000 balance', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);
    const [orderA, orderB] = await Promise.all([
      seedOrder(customerUserId, 700),
      seedOrder(customerUserId, 700),
    ]);

    const results = await Promise.allSettled([
      spend.execute({
        customerUserId,
        orderId: orderA.id,
        amount: 700,
        idempotencyKey: `wallet-spend-a-${randomUUID()}`,
      }),
      spend.execute({
        customerUserId,
        orderId: orderB.id,
        amount: 700,
        idempotencyKey: `wallet-spend-b-${randomUUID()}`,
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as ApiException).code).toBe(ErrorCode.INSUFFICIENT_WALLET_BALANCE);

    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'WALLET_SPEND' } })).toBe(1);
    const balance = await balanceOf(customerUserId);
    expect(balance).toBe(300);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(await balanceFromEntries(customerUserId)).toBe(300);
  });

  it('never lets a wallet go negative across a long mixed sequence', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);

    for (const amount of [400, 400, 400, 200, 1]) {
      const order = await seedOrder(customerUserId, amount);
      await spend
        .execute({
          customerUserId,
          orderId: order.id,
          amount,
          idempotencyKey: `wallet-spend-${randomUUID()}`,
        })
        .catch((err: unknown) => {
          expect((err as ApiException).code).toBe(ErrorCode.INSUFFICIENT_WALLET_BALANCE);
        });
      expect(await balanceOf(customerUserId)).toBeGreaterThanOrEqual(0);
    }

    expect(await balanceOf(customerUserId)).toBe(0);
  });

  it('replays a spend for the same order without a second debit', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);
    const order = await seedOrder(customerUserId, 400);
    const req = {
      customerUserId,
      orderId: order.id,
      amount: 400,
      idempotencyKey: `wallet-spend-${randomUUID()}`,
    };
    await spend.execute(req);

    const replay = await spend.execute(req);

    expect(replay.replay).toBe(true);
    expect(await balanceOf(customerUserId)).toBe(600);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'WALLET_SPEND' } })).toBe(1);
  });

  it('rejects the same order re-spent for a different amount', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);
    const order = await seedOrder(customerUserId, 400);
    await spend.execute({
      customerUserId,
      orderId: order.id,
      amount: 400,
      idempotencyKey: `wallet-spend-${randomUUID()}`,
    });

    await expect(
      spend.execute({
        customerUserId,
        orderId: order.id,
        amount: 500,
        idempotencyKey: `wallet-spend-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_CONFLICT });

    expect(await balanceOf(customerUserId)).toBe(600);
  });

  it('collapses two concurrent spends of the same order into one debit', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);
    const order = await seedOrder(customerUserId, 400);

    const results = await Promise.allSettled([
      spend.execute({
        customerUserId,
        orderId: order.id,
        amount: 400,
        idempotencyKey: `wallet-spend-a-${randomUUID()}`,
      }),
      spend.execute({
        customerUserId,
        orderId: order.id,
        amount: 400,
        idempotencyKey: `wallet-spend-b-${randomUUID()}`,
      }),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'WALLET_SPEND' } })).toBe(1);
    expect(await balanceOf(customerUserId)).toBe(600);
  });

  // ===========================================================================================
  // Audit and outbox
  // ===========================================================================================

  it('records audit entries and the catalogued wallet events for both movements', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);
    const order = await seedOrder(customerUserId, 400);
    await spend.execute({
      customerUserId,
      orderId: order.id,
      amount: 400,
      idempotencyKey: `wallet-spend-${randomUUID()}`,
    });

    const audits = await ctx.prisma.auditLog.findMany({
      where: { resourceType: 'Wallet', resourceId: customerUserId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['WALLET_TOPPED_UP', 'WALLET_SPENT']);
    expect(audits[0].context).toMatchObject({ amount: 1_000, outcome: 'CREDITED' });
    expect(audits[1].context).toMatchObject({
      amount: 400,
      orderId: order.id,
      ledgerReference: `WALLET-SPEND-${order.id}`,
      outcome: 'DEBITED',
    });
    // §13: no gateway credential, token or raw payload in the financial trail.
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain('providerToken');

    const events = await ctx.prisma.outbox.findMany({
      where: { aggregateType: 'Wallet', aggregateId: customerUserId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual(['wallet.credited', 'wallet.debited']);
    // Exactly the catalogued two — no invented wallet.balance_changed or wallet.hold_created.
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateType: 'Wallet', eventType: { notIn: ['wallet.credited', 'wallet.debited'] } },
      }),
    ).toBe(0);
  });

  it('rolls back the audit entry and the event when a spend is refused', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 100);
    const order = await seedOrder(customerUserId, 500);

    await expect(
      spend.execute({
        customerUserId,
        orderId: order.id,
        amount: 500,
        idempotencyKey: `wallet-spend-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(ApiException);

    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'WALLET_SPENT' } }),
    ).toBe(0);
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'wallet.debited' } }),
    ).toBe(0);
  });

  // ===========================================================================================
  // HTTP (§9.4)
  // ===========================================================================================

  it('serves the customer their own derived balance and summary', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await fundWallet(customer.userId, 1_000);

    const data = body(
      await request(ctx.server)
        .get('/wallet')
        .set(...auth(customer.accessToken))
        .expect(200),
    );

    expect(data).toEqual({
      balance: 1_000,
      currency: 'ETB',
      totalCredited: 1_000,
      totalDebited: 0,
      transactionCount: 1,
    });
  });

  it('serves a zero balance for a customer who has never transacted', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');

    const data = body(
      await request(ctx.server)
        .get('/wallet')
        .set(...auth(customer.accessToken))
        .expect(200),
    );

    expect(data).toMatchObject({ balance: 0, transactionCount: 0 });
  });

  it('serves the transaction history with safe fields only', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const payment = await fundWallet(customer.userId, 1_000);
    const order = await seedOrder(customer.userId, 400);
    await spend.execute({
      customerUserId: customer.userId,
      orderId: order.id,
      amount: 400,
      idempotencyKey: `wallet-spend-${randomUUID()}`,
    });

    const response = await request(ctx.server)
      .get('/wallet/transactions')
      .set(...auth(customer.accessToken))
      .expect(200);
    const data = body(response);
    const items = data.items as Array<Record<string, unknown>>;

    expect(data).toMatchObject({ total: 2, page: 1, size: 20 });
    expect(items.map((item) => [item.reference, item.direction, item.amount])).toEqual([
      [`WALLET-SPEND-${order.id}`, 'DEBIT', 400],
      [`WALLET-TOPUP-${payment.paymentId}`, 'CREDIT', 1_000],
    ]);
    expect(Object.keys(items[0]).sort()).toEqual(
      [
        'reference',
        'type',
        'direction',
        'amount',
        'currency',
        'description',
        'relatedType',
        'relatedId',
        'createdAt',
      ].sort(),
    );
    // No internal ids, and no sign of the counterpart platform account.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('accountId');
    expect(serialized).not.toContain('transactionId');
    expect(serialized).not.toContain('GATEWAY_CLEARING');
  });

  it('shows a refund credited to the wallet in both the balance and the history', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const order = await seedOrder(customer.userId, 1_000, 100);
    const authorized = await authorize.execute({
      customerUserId: customer.userId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    await capture.execute({ paymentId: authorized.paymentId });
    const refunded = await refund.execute({
      paymentId: authorized.paymentId,
      amount: 250,
      destination: RefundDestination.WALLET,
      idempotencyKey: `refund-${randomUUID()}`,
      initiator: RefundInitiator.SYSTEM,
    });

    const wallet = body(
      await request(ctx.server)
        .get('/wallet')
        .set(...auth(customer.accessToken))
        .expect(200),
    );
    const history = body(
      await request(ctx.server)
        .get('/wallet/transactions')
        .set(...auth(customer.accessToken))
        .expect(200),
    );

    expect(wallet).toMatchObject({ balance: 250, totalCredited: 250, transactionCount: 1 });
    expect((history.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      reference: `REFUND-${refunded.refundId}`,
      direction: 'CREDIT',
      amount: 250,
      type: 'REFUND',
      relatedType: 'refund',
    });
  });

  it("never shows one customer another customer's wallet", async () => {
    const owner = await createUserWithRole(ctx, 'CUSTOMER');
    const intruder = await createUserWithRole(ctx, 'CUSTOMER');
    await fundWallet(owner.userId, 5_000);

    const balance = body(
      await request(ctx.server)
        .get('/wallet')
        .set(...auth(intruder.accessToken))
        .expect(200),
    );
    const history = body(
      await request(ctx.server)
        .get('/wallet/transactions')
        .set(...auth(intruder.accessToken))
        .expect(200),
    );

    // Their own empty wallet, not a 403 and certainly not the owner's money.
    expect(balance).toMatchObject({ balance: 0, transactionCount: 0 });
    expect(history.items).toEqual([]);
    expect(JSON.stringify(history.body ?? history)).not.toContain('5000');
  });

  it('accepts no client-supplied identity on either route', async () => {
    const owner = await createUserWithRole(ctx, 'CUSTOMER');
    const intruder = await createUserWithRole(ctx, 'CUSTOMER');
    await fundWallet(owner.userId, 5_000);

    // A query parameter naming someone else is refused outright, never honoured.
    for (const field of ['userId', 'customerUserId', 'accountId', 'walletAccountId']) {
      await request(ctx.server)
        .get(`/wallet/transactions?${field}=${owner.userId}`)
        .set(...auth(intruder.accessToken))
        .expect(400);
    }
  });

  it('rejects an out-of-range page size', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');

    await request(ctx.server)
      .get('/wallet/transactions?size=500')
      .set(...auth(customer.accessToken))
      .expect(400);
    await request(ctx.server)
      .get('/wallet/transactions?page=0')
      .set(...auth(customer.accessToken))
      .expect(400);
  });

  it('requires authentication on both routes', async () => {
    await request(ctx.server).get('/wallet').expect(401);
    await request(ctx.server).get('/wallet/transactions').expect(401);
  });

  it('refuses a caller who does not hold wallet:read:own', async () => {
    // Every registered user carries CUSTOMER, and a customer legitimately holds `wallet:read:own`
    // — a finance officer has a wallet like anyone else. To prove the route is actually guarded,
    // strip the roles and re-issue the token: the same request then has no permission behind it.
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await ctx.prisma.userRole.deleteMany({ where: { userId: customer.userId } });
    const stripped = await login(ctx, customer.phone, customer.password);

    await request(ctx.server)
      .get('/wallet')
      .set(...auth(stripped.accessToken))
      .expect(403);
    await request(ctx.server)
      .get('/wallet/transactions')
      .set(...auth(stripped.accessToken))
      .expect(403);
  });

  it('exposes no HTTP route that can move wallet money', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await fundWallet(customer.userId, 1_000);

    // §9.4's top-up route is not built (no order-less payment exists to fund it), and spend is
    // internal by design — a customer must not be able to move their own money outside a checkout.
    for (const path of ['/wallet/topup', '/wallet/spend']) {
      const response = await request(ctx.server)
        .post(path)
        .set(...auth(customer.accessToken))
        .set('Idempotency-Key', `wallet-${randomUUID()}`)
        .send({ amount: 100, method: 'TELEBIRR' });
      expect(response.status).toBe(404);
    }
    expect(await balanceOf(customer.userId)).toBe(1_000);
  });

  it('exposes wallet spend to other modules in-process instead', async () => {
    const customerUserId = `customer-${randomUUID()}`;
    await fundWallet(customerUserId, 1_000);
    const order = await seedOrder(customerUserId, 400);

    // What Module 06's checkout saga will call. Not wired into checkout by this task.
    const result = await walletPort.spend({
      customerUserId,
      orderId: order.id,
      amount: 400,
      idempotencyKey: `wallet-spend-${randomUUID()}`,
    });

    expect(result).toMatchObject({ amount: 400, balance: 600, replay: false });
    expect((await walletPort.balance(customerUserId)).balance).toBe(600);
  });
});
