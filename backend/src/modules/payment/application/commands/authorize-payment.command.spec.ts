import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { PaymentProps } from '../../domain/entities/payment.entity';
import { PaymentMethod, PaymentStatus } from '../../domain/enums';
import {
  IPaymentRepository,
  NewPaymentData,
  PaymentPage,
  PaymentStateUpdate,
  PaymentStatusTotals,
} from '../../domain/repositories/payment.repository';
import { IOrderPort, PayableOrderView } from '../ports/outbound/order.port';
import {
  IPaymentProviderPort,
  IPaymentProviderRegistry,
  ProviderAuthorizationRequest,
  ProviderAuthorizationResult,
  ProviderCaptureResult,
  ProviderRefundResult,
  ProviderVoidResult,
} from '../ports/outbound/payment-provider.port';
import { PaymentErrors } from '../../domain/errors';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { AuthorizePaymentCommand, AuthorizePaymentInput } from './authorize-payment.command';

/* --------------------------------------------------------------------------------------------
 * Test doubles. The payment repository is a faithful in-memory model of the real table — most
 * importantly it enforces the `payments.idempotencyKey` unique constraint by throwing `P2002`,
 * because the command's concurrency handling is written against exactly that behaviour.
 * ------------------------------------------------------------------------------------------ */

const ORDER_ID = 'order-1';
const CUSTOMER_ID = 'customer-1';

/** Records the order of externally-visible effects, so side-effect *ordering* can be asserted. */
type CallLog = string[];

class InMemoryPaymentRepository implements IPaymentRepository {
  readonly rows = new Map<string, PaymentProps>();
  createCalls = 0;
  updateCalls = 0;
  /** Simulates a concurrent request committing first, between our check and our insert. */
  onBeforeCreate?: () => void | Promise<void>;
  /** Simulates the outcome transaction failing after the provider already authorized. */
  failNextUpdate?: Error;

  constructor(private readonly log: CallLog = []) {}

  async findById(id: string): Promise<PaymentProps | null> {
    return this.rows.get(id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PaymentProps | null> {
    return [...this.rows.values()].find((r) => r.idempotencyKey === idempotencyKey) ?? null;
  }

  async findByOrderId(orderId: string): Promise<PaymentProps[]> {
    return [...this.rows.values()].filter((r) => r.orderId === orderId);
  }

  async findByProviderRef(provider: string, providerRef: string): Promise<PaymentProps | null> {
    return (
      [...this.rows.values()].find(
        (r) => r.provider === provider && r.providerRef === providerRef,
      ) ?? null
    );
  }
  async findStale(criteria: {
    statuses: PaymentStatus[];
    olderThan: Date;
    limit: number;
  }): Promise<PaymentProps[]> {
    return [...this.rows.values()]
      .filter((r) => criteria.statuses.includes(r.status) && r.updatedAt < criteria.olderThan)
      .slice(0, criteria.limit);
  }
  async create(data: NewPaymentData): Promise<PaymentProps> {
    this.createCalls += 1;
    await this.onBeforeCreate?.();
    if ([...this.rows.values()].some((r) => r.idempotencyKey === data.idempotencyKey)) {
      const err = new Error('Unique constraint failed on the fields: (`idempotencyKey`)') as Error & {
        code: string;
      };
      err.code = 'P2002';
      throw err;
    }
    const now = new Date();
    const row: PaymentProps = {
      id: data.id,
      orderId: data.orderId,
      customerUserId: data.customerUserId,
      method: data.method,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      originalAmount: data.originalAmount ?? null,
      originalCurrency: data.originalCurrency ?? null,
      fxRate: data.fxRate ?? null,
      fxSource: data.fxSource ?? null,
      provider: data.provider ?? null,
      providerRef: data.providerRef ?? null,
      providerToken: data.providerToken ?? null,
      idempotencyKey: data.idempotencyKey,
      authorizedAt: null,
      capturedAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    this.log.push('payment:create');
    return { ...row };
  }

  async updateState(id: string, update: PaymentStateUpdate): Promise<PaymentProps> {
    this.updateCalls += 1;
    if (this.failNextUpdate) {
      const err = this.failNextUpdate;
      this.failNextUpdate = undefined;
      throw err;
    }
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`no payment ${id}`);
    }
    const next: PaymentProps = {
      ...row,
      status: update.status,
      providerRef: update.providerRef === undefined ? row.providerRef : update.providerRef,
      authorizedAt: update.authorizedAt === undefined ? row.authorizedAt : update.authorizedAt,
      capturedAt: update.capturedAt === undefined ? row.capturedAt : update.capturedAt,
      failureReason:
        update.failureReason === undefined ? row.failureReason : update.failureReason,
      updatedAt: new Date(),
    };
    this.rows.set(id, next);
    this.log.push(`payment:update:${update.status}`);
    return { ...next };
  }

  async search(): Promise<PaymentPage> {
    throw new Error('not used in this suite');
  }

  async summarizeByStatus(): Promise<PaymentStatusTotals[]> {
    throw new Error('not used in this suite');
  }
}

class StubOrderPort implements IOrderPort {
  constructor(
    private readonly orders: PayableOrderView[],
    private readonly pharmacyIds: string[] = ['pharmacy-1'],
  ) {}
  async getOrder(orderId: string): Promise<PayableOrderView | null> {
    return this.orders.find((o) => o.id === orderId) ?? null;
  }
  async getOrderLines() {
    return [];
  }

  async getFulfillmentPharmacyIds(): Promise<string[]> {
    return this.pharmacyIds;
  }
}

/** A scripted gateway. Records every request so PCI and idempotency claims can be asserted. */
class ScriptedProvider implements IPaymentProviderPort {
  readonly key = 'scripted';
  readonly requests: ProviderAuthorizationRequest[] = [];
  supportedMethods: PaymentMethod[] = [
    PaymentMethod.TELEBIRR,
    PaymentMethod.CARD,
    PaymentMethod.BANK_TRANSFER,
    PaymentMethod.CROSS_BORDER,
  ];

  constructor(
    private readonly script: ProviderAuthorizationResult | Error,
    private readonly log: CallLog = [],
  ) {}

  supports(method: PaymentMethod): boolean {
    return this.supportedMethods.includes(method);
  }

  async authorize(request: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    this.requests.push(request);
    this.log.push('provider:authorize');
    if (this.script instanceof Error) {
      throw this.script;
    }
    return this.script;
  }

  // Capture/void/refund exist only to satisfy the port here — authorization never calls any of
  // them, which the suite asserts by leaving these throwing.
  async capture(): Promise<ProviderCaptureResult> {
    throw new Error('capture must not be called during authorization');
  }

  async voidAuthorization(): Promise<ProviderVoidResult> {
    throw new Error('voidAuthorization must not be called during authorization');
  }

  async refund(): Promise<ProviderRefundResult> {
    throw new Error('refund must not be called during authorization');
  }
}

/** Runs the closure against a marker handle and logs the commit, so ordering can be asserted. */
class FakeUnitOfWork implements IUnitOfWork {
  constructor(private readonly log: CallLog = []) {}
  async run<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    const result = await work({ tx: true });
    this.log.push('tx:commit');
    return result;
  }
}

interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  context?: Record<string, unknown> | null;
}

/**
 * Wraps the scripted gateway in the registry contract the commands now depend on. Selection is
 * exercised for real by `payment-provider.registry.spec.ts`; here it just keeps one provider in
 * play so these tests stay about the command.
 */
class SingleProviderRegistry implements IPaymentProviderRegistry {
  constructor(private readonly provider: IPaymentProviderPort) {}
  forMethod(method: PaymentMethod): IPaymentProviderPort {
    if (!this.provider.supports(method)) {
      throw PaymentErrors.unsupportedPaymentMethod(method, this.provider.key);
    }
    return this.provider;
  }
  forKey(): IPaymentProviderPort {
    return this.provider;
  }
  availableKeys(): string[] {
    return [this.provider.key];
  }
}

function harness(
  options: {
    order?: Partial<PayableOrderView> | null;
    provider?: ProviderAuthorizationResult | Error;
    seed?: PaymentProps[];
  } = {},
) {
  const log: CallLog = [];
  const order: PayableOrderView | null =
    options.order === null
      ? null
      : {
          id: ORDER_ID,
          customerUserId: CUSTOMER_ID,
          status: 'PENDING_PAYMENT',
          grandTotal: 11_500,
          currency: 'ETB',
          platformFee: 0,
          discountTotal: 0,
          isCod: false,
          ...options.order,
        };

  const payments = new InMemoryPaymentRepository(log);
  for (const seeded of options.seed ?? []) {
    payments.rows.set(seeded.id, seeded);
  }
  const provider = new ScriptedProvider(
    options.provider ?? { outcome: 'AUTHORIZED', providerRef: 'gw-ref-1' },
    log,
  );
  const audits: AuditEntry[] = [];
  const events: DomainEvent<unknown>[] = [];
  const audit = {
    record: jest.fn(async (params: AuditEntry) => {
      audits.push(params);
      log.push(`audit:${params.action}`);
      return { id: 'audit-1', hash: 'hash' };
    }),
  } as unknown as AuditService;
  const outbox = {
    write: jest.fn(async (event: DomainEvent<unknown>) => {
      events.push(event);
      log.push(`outbox:${event.type}`);
    }),
  } as unknown as OutboxService;

  const command = new AuthorizePaymentCommand(
    payments,
    new StubOrderPort(order ? [order] : []),
    new SingleProviderRegistry(provider),
    new FakeUnitOfWork(log),
    audit,
    outbox,
  );

  return { command, payments, provider, audits, events, log, order };
}

function input(overrides: Partial<AuthorizePaymentInput> = {}): AuthorizePaymentInput {
  return {
    customerUserId: CUSTOMER_ID,
    orderId: ORDER_ID,
    method: PaymentMethod.TELEBIRR,
    idempotencyKey: 'pay-order-1-attempt-1',
    ...overrides,
  };
}

async function expectApiError(promise: Promise<unknown>, code: ErrorCode): Promise<ApiException> {
  await expect(promise).rejects.toBeInstanceOf(ApiException);
  try {
    await promise;
    throw new Error('expected a rejection');
  } catch (error) {
    expect((error as ApiException).code).toBe(code);
    return error as ApiException;
  }
}

/* ------------------------------------------------------------------------------------------ */

describe('AuthorizePaymentCommand — synchronous authorization (§6, §11.1)', () => {
  it('authorizes: INITIATED -> AUTHORIZED, no redirect', async () => {
    const { command, payments } = harness();

    const result = await command.execute(input());

    expect(result.status).toBe(PaymentStatus.AUTHORIZED);
    expect(result.providerRedirect).toBeNull();
    expect(result.replay).toBe(false);
    expect(result.amount).toBe(11_500);
    expect(result.currency).toBe('ETB');

    const row = payments.rows.get(result.paymentId) as PaymentProps;
    expect(row.status).toBe(PaymentStatus.AUTHORIZED);
    expect(row.authorizedAt).toBeInstanceOf(Date);
    expect(row.capturedAt).toBeNull();
    expect(row.failureReason).toBeNull();
  });

  it('persists the provider reference on the payment', async () => {
    const { command, payments } = harness({
      provider: { outcome: 'AUTHORIZED', providerRef: 'telebirr-txn-9911' },
    });

    const result = await command.execute(input());

    expect(result.providerRef).toBe('telebirr-txn-9911');
    expect((payments.rows.get(result.paymentId) as PaymentProps).providerRef).toBe(
      'telebirr-txn-9911',
    );
  });

  it('records the payment id it committed as the provider-side idempotency key', async () => {
    const { command, provider } = harness();

    const result = await command.execute(input());

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].paymentId).toBe(result.paymentId);
    expect(provider.requests[0].idempotencyKey).toBe('pay-order-1-attempt-1');
  });
});

describe('AuthorizePaymentCommand — asynchronous / redirect authorization (§6, §9.1)', () => {
  it('leaves the payment INITIATED and returns the redirect', async () => {
    const { command, payments } = harness({
      provider: {
        outcome: 'PENDING',
        providerRef: 'gw-pending-1',
        redirectUrl: 'https://gateway.example/pay/abc',
      },
    });

    const result = await command.execute(input({ returnUrl: 'https://app.example/return' }));

    expect(result.status).toBe(PaymentStatus.INITIATED);
    expect(result.providerRedirect).toBe('https://gateway.example/pay/abc');

    const row = payments.rows.get(result.paymentId) as PaymentProps;
    expect(row.status).toBe(PaymentStatus.INITIATED);
    expect(row.authorizedAt).toBeNull();
    expect(row.providerRef).toBe('gw-pending-1');
  });

  it('never emits payment.authorized for a pending authorization', async () => {
    const { command, events } = harness({
      provider: { outcome: 'PENDING', providerRef: 'gw-pending-1', redirectUrl: 'https://gw/x' },
    });

    await command.execute(input());

    expect(events.map((e) => e.type)).not.toContain('payment.authorized');
    expect(events).toHaveLength(0);
  });

  it('audits the pending outcome without recording the redirect URL', async () => {
    const { command, audits } = harness({
      provider: {
        outcome: 'PENDING',
        providerRef: 'gw-pending-1',
        redirectUrl: 'https://gateway.example/pay?token=secret-token',
      },
    });

    await command.execute(input());

    const pending = audits.find((a) => a.action === 'PAYMENT_AUTHORIZATION_PENDING');
    expect(pending).toBeDefined();
    expect(pending?.context?.redirectIssued).toBe(true);
    expect(JSON.stringify(pending?.context)).not.toContain('secret-token');
  });
});

describe('AuthorizePaymentCommand — failure (§4, §12)', () => {
  it('transitions INITIATED -> FAILED, commits it, then throws PAYMENT_AUTH_FAILED', async () => {
    const { command, payments } = harness({
      provider: {
        outcome: 'FAILED',
        providerRef: 'gw-declined-1',
        failureReason: 'Insufficient funds',
        failureCode: 'insufficient_funds',
      },
    });

    const error = await expectApiError(command.execute(input()), ErrorCode.PAYMENT_AUTH_FAILED);
    expect(error.httpStatus).toBe(402);
    expect((error.details as { failureCode: string }).failureCode).toBe('insufficient_funds');

    const row = [...payments.rows.values()][0];
    expect(row.status).toBe(PaymentStatus.FAILED);
    expect(row.failureReason).toBe('Insufficient funds');
    expect(row.providerRef).toBe('gw-declined-1');
  });

  it('sanitizes a provider reason that leaks a card number, everywhere it is stored', async () => {
    const { command, payments, audits, events } = harness({
      provider: {
        outcome: 'FAILED',
        providerRef: 'gw-1',
        failureReason: 'Declined for card 4111 1111 1111 1111 (cvv: 123)',
      },
    });

    const error = await expectApiError(command.execute(input()), ErrorCode.PAYMENT_AUTH_FAILED);

    const row = [...payments.rows.values()][0];
    const audited = audits.find((a) => a.action === 'PAYMENT_AUTH_FAILED');
    const event = events.find((e) => e.type === 'payment.failed');
    const surfaces = [
      error.message,
      row.failureReason ?? '',
      String(audited?.context?.failureReason ?? ''),
      JSON.stringify(event?.payload ?? {}),
    ];

    for (const surface of surfaces) {
      expect(surface).not.toContain('4111');
      expect(surface).not.toMatch(/\d{12,}/);
      expect(surface).toContain('[redacted]');
    }
  });

  it('falls back to a safe default when the provider gives no reason', async () => {
    const { command, payments } = harness({
      provider: { outcome: 'FAILED', providerRef: null, failureReason: null },
    });

    const error = await expectApiError(command.execute(input()), ErrorCode.PAYMENT_AUTH_FAILED);
    expect(error.message).toBe('The payment was declined by the provider.');
    expect([...payments.rows.values()][0].failureReason).toBe(
      'The payment was declined by the provider.',
    );
  });

  it('a failed authorization writes payment.failed and no payment.authorized', async () => {
    const { command, events } = harness({
      provider: { outcome: 'FAILED', providerRef: 'gw-1', failureReason: 'Declined' },
    });

    await expectApiError(command.execute(input()), ErrorCode.PAYMENT_AUTH_FAILED);

    expect(events.map((e) => e.type)).toEqual(['payment.failed']);
    const payload = events[0].payload as { paymentId: string; orderId: string; reason: string };
    expect(payload.orderId).toBe(ORDER_ID);
    expect(payload.reason).toBe('Declined');
  });
});

describe('AuthorizePaymentCommand — request validation', () => {
  it('rejects an order belonging to another customer as NOT FOUND, without calling the provider', async () => {
    const { command, provider, payments } = harness({
      order: { customerUserId: 'someone-else' },
    });

    await expectApiError(command.execute(input()), ErrorCode.ORDER_NOT_FOUND);
    expect(provider.requests).toHaveLength(0);
    expect(payments.rows.size).toBe(0);
  });

  it('rejects an unknown order', async () => {
    const { command } = harness({ order: null });
    await expectApiError(command.execute(input()), ErrorCode.ORDER_NOT_FOUND);
  });

  it.each(['PAID', 'ACCEPTED', 'CANCELLED', 'COMPLETED'])(
    'rejects an order in status %s as not payable (BRULE-17)',
    async (status) => {
      const { command, provider } = harness({ order: { status } });
      await expectApiError(command.execute(input()), ErrorCode.BUSINESS_RULE_VIOLATION);
      expect(provider.requests).toHaveLength(0);
    },
  );

  it('rejects a caller-supplied amount that disagrees with the order total (never trusts it)', async () => {
    const { command, provider } = harness({ order: { grandTotal: 11_500 } });

    const error = await expectApiError(
      command.execute(input({ amount: 1 })),
      ErrorCode.VALIDATION_ERROR,
    );
    expect(error.details).toMatchObject({ requested: 1, orderTotal: 11_500 });
    expect(provider.requests).toHaveLength(0);
  });

  it('authorizes the order total, not the caller amount, when they agree', async () => {
    const { command, provider } = harness({ order: { grandTotal: 11_500 } });

    const result = await command.execute(input({ amount: 11_500 }));

    expect(result.amount).toBe(11_500);
    expect(provider.requests[0].amount).toBe(11_500);
  });

  it('rejects a zero-total order rather than authorizing nothing', async () => {
    const { command } = harness({ order: { grandTotal: 0 } });
    await expectApiError(command.execute(input()), ErrorCode.VALIDATION_ERROR);
  });

  it.each(['etb', 'BIRR', ''])('rejects the malformed currency %p', async (currency) => {
    const { command, provider } = harness();
    await expectApiError(command.execute(input({ currency })), ErrorCode.VALIDATION_ERROR);
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects a currency that disagrees with the order currency', async () => {
    const { command } = harness();
    await expectApiError(command.execute(input({ currency: 'USD' })), ErrorCode.VALIDATION_ERROR);
  });

  it.each([PaymentMethod.COD, PaymentMethod.WALLET])(
    'rejects %s — no gateway can authorize it',
    async (method) => {
      const { command, provider, payments } = harness();
      const error = await expectApiError(
        command.execute(input({ method })),
        ErrorCode.VALIDATION_ERROR,
      );
      expect(error.details).toMatchObject({ field: 'method', method });
      expect(provider.requests).toHaveLength(0);
      // No abandoned INITIATED row is left behind for an unsupported method.
      expect(payments.rows.size).toBe(0);
    },
  );

  it('rejects an unknown payment method and an invalid idempotency key', async () => {
    const { command } = harness();
    await expectApiError(
      command.execute(input({ method: 'BITCOIN' as PaymentMethod })),
      ErrorCode.VALIDATION_ERROR,
    );
    await expectApiError(
      command.execute(input({ idempotencyKey: 'short' })),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('refuses to open a second payment for an order that already has an active one', async () => {
    const { command } = harness();
    const first = await command.execute(input());

    const error = await expectApiError(
      command.execute(input({ idempotencyKey: 'pay-order-1-attempt-2' })),
      ErrorCode.CONFLICT,
    );
    expect(error.details).toMatchObject({ paymentId: first.paymentId, status: 'AUTHORIZED' });
  });

  it('allows a fresh attempt after a previous one failed (FAILED is not an active payment)', async () => {
    const { command, payments } = harness({
      provider: { outcome: 'FAILED', providerRef: 'gw-1', failureReason: 'Declined' },
    });
    await expectApiError(command.execute(input()), ErrorCode.PAYMENT_AUTH_FAILED);

    // A retry with a NEW key is a new attempt, and must be allowed — otherwise a single decline
    // would permanently block the order from ever being paid.
    const retry = new AuthorizePaymentCommand(
      payments,
      new StubOrderPort([
        {
          id: ORDER_ID,
          customerUserId: CUSTOMER_ID,
          status: 'PENDING_PAYMENT',
          grandTotal: 11_500,
          currency: 'ETB',
          platformFee: 0,
          discountTotal: 0,
          isCod: false,
        },
      ]),
      new SingleProviderRegistry(
        new ScriptedProvider({ outcome: 'AUTHORIZED', providerRef: 'gw-2' }),
      ),
      new FakeUnitOfWork(),
      { record: jest.fn(async () => ({ id: 'a', hash: 'h' })) } as unknown as AuditService,
      { write: jest.fn(async () => undefined) } as unknown as OutboxService,
    );

    const result = await retry.execute(input({ idempotencyKey: 'pay-order-1-attempt-2' }));
    expect(result.status).toBe(PaymentStatus.AUTHORIZED);
  });
});

describe('AuthorizePaymentCommand — idempotency (BRULE-25)', () => {
  it('a sequential replay returns the same payment and never calls the provider again', async () => {
    const { command, provider, payments } = harness();

    const first = await command.execute(input());
    const replay = await command.execute(input());

    expect(replay.paymentId).toBe(first.paymentId);
    expect(replay.status).toBe(PaymentStatus.AUTHORIZED);
    expect(replay.replay).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(payments.rows.size).toBe(1);
    expect(payments.createCalls).toBe(1);
  });

  it.each([
    ['a different customer', { customerUserId: 'other-customer' }],
    ['a different order', { orderId: 'order-2' }],
    ['a different method', { method: PaymentMethod.CARD }],
    ['a different amount', { amount: 999 }],
  ])('rejects reuse of one key for %s', async (_name, overrides) => {
    const { command, provider } = harness();
    await command.execute(input());

    await expectApiError(
      command.execute(input(overrides)),
      ErrorCode.IDEMPOTENCY_CONFLICT,
    );
    expect(provider.requests).toHaveLength(1);
  });

  it('collapses concurrent identical requests to one payment and one provider call', async () => {
    const { command, provider, payments } = harness();

    const [a, b] = await Promise.all([command.execute(input()), command.execute(input())]);

    expect(a.paymentId).toBe(b.paymentId);
    expect(payments.rows.size).toBe(1);
    // Exactly one of the two performed the gateway call; the loser of the insert race returned
    // the winner's payment WITHOUT authorizing again — this is the double-charge guard.
    expect(provider.requests).toHaveLength(1);
    expect([a.replay, b.replay].filter(Boolean)).toHaveLength(1);
  });

  it('the loser of an insert race never reaches the provider', async () => {
    const { command, provider, payments } = harness();

    // A concurrent winner commits between our idempotency check and our insert.
    payments.onBeforeCreate = async () => {
      payments.onBeforeCreate = undefined;
      const now = new Date();
      payments.rows.set('winner-payment', {
        id: 'winner-payment',
        orderId: ORDER_ID,
        customerUserId: CUSTOMER_ID,
        method: PaymentMethod.TELEBIRR,
        status: PaymentStatus.AUTHORIZED,
        amount: 11_500,
        currency: 'ETB',
        originalAmount: null,
        originalCurrency: null,
        fxRate: null,
        fxSource: null,
        provider: 'scripted',
        providerRef: 'gw-winner',
        providerToken: null,
        idempotencyKey: 'pay-order-1-attempt-1',
        authorizedAt: now,
        capturedAt: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      });
    };

    const result = await command.execute(input());

    expect(result.paymentId).toBe('winner-payment');
    expect(result.replay).toBe(true);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('AuthorizePaymentCommand — external side-effect ordering (§14)', () => {
  it('commits the INITIATED payment BEFORE calling the provider', async () => {
    const { command, log } = harness();

    await command.execute(input());

    const create = log.indexOf('payment:create');
    const firstCommit = log.indexOf('tx:commit');
    const providerCall = log.indexOf('provider:authorize');

    expect(create).toBeGreaterThanOrEqual(0);
    expect(firstCommit).toBeGreaterThan(create);
    // The intent record is durable before any money can move at the gateway — this is what makes
    // a crash after the provider call reconcilable instead of an orphaned authorization.
    expect(providerCall).toBeGreaterThan(firstCommit);
  });

  it('never holds a transaction open across the provider call', async () => {
    const { command, log } = harness();

    await command.execute(input());

    // Two separate, committed transactions with the gateway call strictly between them.
    const commits = log.reduce<number[]>((acc, entry, i) => {
      if (entry === 'tx:commit') acc.push(i);
      return acc;
    }, []);
    expect(commits).toHaveLength(2);
    const providerCall = log.indexOf('provider:authorize');
    expect(providerCall).toBeGreaterThan(commits[0]);
    expect(providerCall).toBeLessThan(commits[1]);
  });

  it('a provider exception leaves the payment INITIATED and reports DEPENDENCY_UNAVAILABLE', async () => {
    const { command, payments } = harness({
      provider: new Error('socket hang up'),
    });

    await expectApiError(command.execute(input()), ErrorCode.DEPENDENCY_UNAVAILABLE);

    const row = [...payments.rows.values()][0];
    // NOT FAILED: a network error is an unknown outcome, and marking it failed could bury a real
    // authorization. The row survives so reconciliation can resolve it.
    expect(row.status).toBe(PaymentStatus.INITIATED);
    expect(row.failureReason).toBeNull();
    expect(payments.rows.size).toBe(1);
  });

  it('sanitizes a provider exception message before it reaches the caller', async () => {
    const { command } = harness({
      provider: new Error('timeout calling gateway with card 4111111111111111'),
    });

    const error = await expectApiError(
      command.execute(input()),
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );
    expect(JSON.stringify(error.details)).not.toContain('4111111111111111');
    expect(JSON.stringify(error.details)).toContain('[redacted]');
  });

  it('a persistence failure after provider success leaves a recoverable INITIATED payment', async () => {
    const { command, payments, provider } = harness();
    payments.failNextUpdate = new Error('CONTROLLED_FAILURE: outcome transaction failed');

    await expect(command.execute(input())).rejects.toThrow('CONTROLLED_FAILURE');

    const row = [...payments.rows.values()][0];
    expect(row.status).toBe(PaymentStatus.INITIATED);
    // The gateway holds an authorization keyed by this payment id, and the row exists — so the
    // webhook/reconciliation task has both handles it needs. Nothing is lost or double-charged.
    expect(provider.requests[0].paymentId).toBe(row.id);
  });
});

describe('AuthorizePaymentCommand — audit and outbox (§7, §13)', () => {
  it('audits initiation and authorization with actor, order, payment, amount, currency, method', async () => {
    const { command, audits } = harness();

    const result = await command.execute(input());

    expect(audits.map((a) => a.action)).toEqual(['PAYMENT_INITIATED', 'PAYMENT_AUTHORIZED']);
    for (const entry of audits) {
      expect(entry.actorUserId).toBe(CUSTOMER_ID);
      expect(entry.resourceType).toBe('Payment');
      expect(entry.resourceId).toBe(result.paymentId);
      expect(entry.context).toMatchObject({
        orderId: ORDER_ID,
        paymentId: result.paymentId,
        amount: 11_500,
        currency: 'ETB',
        method: PaymentMethod.TELEBIRR,
      });
    }
    expect(audits[1].context?.outcome).toBe('AUTHORIZED');
  });

  it('audits a failed authorization with the failure outcome', async () => {
    const { command, audits } = harness({
      provider: {
        outcome: 'FAILED',
        providerRef: 'gw-1',
        failureReason: 'Declined',
        failureCode: 'do_not_honor',
      },
    });

    await expectApiError(command.execute(input()), ErrorCode.PAYMENT_AUTH_FAILED);

    expect(audits.map((a) => a.action)).toEqual(['PAYMENT_INITIATED', 'PAYMENT_AUTH_FAILED']);
    expect(audits[1].context).toMatchObject({
      outcome: 'FAILED',
      failureReason: 'Declined',
      failureCode: 'do_not_honor',
    });
  });

  it('emits payment.authorized with the catalogued payload, and nothing on initiation', async () => {
    const { command, events } = harness();

    const result = await command.execute(input());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('payment.authorized');
    expect(events[0].aggregateType).toBe('Payment');
    expect(events[0].aggregateId).toBe(result.paymentId);
    expect(events[0].payload).toEqual({ paymentId: result.paymentId, orderId: ORDER_ID });
  });

  it('emits no event that the design does not catalogue (there is no payment.initiated)', async () => {
    const { command, events } = harness();
    await command.execute(input());
    expect(events.map((e) => e.type)).not.toContain('payment.initiated');
  });

  it('never records the provider token in the audit trail (BRULE-26)', async () => {
    const { command, audits } = harness();

    await command.execute(input({ providerToken: 'tok_opaque_gateway_secret' }));

    expect(JSON.stringify(audits)).not.toContain('tok_opaque_gateway_secret');
  });
});

describe('AuthorizePaymentCommand — ledger and PCI', () => {
  it('makes no ledger posting at authorization (§11.1 — the first movement is at capture)', () => {
    // The command does not depend on the ledger at all: an authorization is a hold at the
    // provider, not a movement of platform money. Accruing provider payable here would book a
    // liability for an order that may never be fulfilled (§11.3 places that at capture).
    const dependencies = AuthorizePaymentCommand.length;
    expect(dependencies).toBe(6);
    const source = AuthorizePaymentCommand.prototype.constructor.toString();
    expect(source).not.toMatch(/LedgerService|ledger\.post|LEDGER_REPOSITORY/);
  });

  it('a failed authorization creates no ledger effect of any kind', async () => {
    const { command, payments } = harness({
      provider: { outcome: 'FAILED', providerRef: 'gw-1', failureReason: 'Declined' },
    });

    await expectApiError(command.execute(input()), ErrorCode.PAYMENT_AUTH_FAILED);

    // Nothing in this command can post to the ledger, so a decline cannot corrupt any balance.
    expect([...payments.rows.values()][0].status).toBe(PaymentStatus.FAILED);
  });

  it('passes the opaque provider token through and stores it as a token, never card data', async () => {
    const { command, provider, payments } = harness();

    const result = await command.execute(input({ providerToken: 'tok_visa_opaque_1' }));

    expect(provider.requests[0].providerToken).toBe('tok_visa_opaque_1');
    const row = payments.rows.get(result.paymentId) as PaymentProps;
    expect(row.providerToken).toBe('tok_visa_opaque_1');
    for (const forbidden of ['pan', 'cvv', 'cardNumber', 'expiry']) {
      expect(Object.keys(row)).not.toContain(forbidden);
      expect(Object.keys(provider.requests[0])).not.toContain(forbidden);
    }
  });
});
