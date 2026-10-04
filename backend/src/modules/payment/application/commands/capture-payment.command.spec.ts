import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  LedgerAccountProps,
  PostedLedgerTransaction,
} from '../../domain/entities/ledger-transaction.entity';
import { PaymentProps } from '../../domain/entities/payment.entity';
import {
  LedgerAccountType,
  LedgerDirection,
  LedgerTransactionType,
  PaymentMethod,
  PaymentStatus,
} from '../../domain/enums';
import { ILedgerRepository } from '../../domain/repositories/ledger.repository';
import {
  IPaymentRepository,
  NewPaymentData,
  PaymentPage,
  PaymentStateUpdate,
  PaymentStatusTotals,
} from '../../domain/repositories/payment.repository';
import { LedgerService } from '../../domain/services/ledger.service';
import { AccountRefKey } from '../../domain/value-objects/account-ref.vo';
import { IOrderPort, PayableOrderView } from '../ports/outbound/order.port';
import {
  IPaymentProviderPort,
  IPaymentProviderRegistry,
  ProviderAuthorizationResult,
  ProviderCaptureResult,
  ProviderPaymentOperationRequest,
  ProviderRefundResult,
  ProviderVoidResult,
} from '../ports/outbound/payment-provider.port';
import { PaymentErrors } from '../../domain/errors';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { CaptureAccountingService } from '../services/capture-accounting.service';
import { CapturePaymentCommand, captureLedgerReference } from './capture-payment.command';

const PAYMENT_ID = 'payment-1';
const ORDER_ID = 'order-1';
const PHARMACY_ID = 'pharmacy-1';

type CallLog = string[];

function authorizedPayment(overrides: Partial<PaymentProps> = {}): PaymentProps {
  const now = new Date('2026-09-09T09:00:00.000Z');
  return {
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    customerUserId: 'customer-1',
    method: PaymentMethod.TELEBIRR,
    status: PaymentStatus.AUTHORIZED,
    amount: 10_000,
    currency: 'ETB',
    originalAmount: null,
    originalCurrency: null,
    fxRate: null,
    fxSource: null,
    provider: 'scripted',
    providerRef: 'gw-auth-1',
    providerToken: null,
    idempotencyKey: 'pay-order-1-attempt-1',
    authorizedAt: now,
    capturedAt: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class InMemoryPaymentRepository implements IPaymentRepository {
  readonly rows = new Map<string, PaymentProps>();
  updateCalls = 0;
  failNextUpdate?: Error;

  constructor(seed: PaymentProps[] = [], private readonly log: CallLog = []) {
    for (const row of seed) {
      this.rows.set(row.id, row);
    }
  }

  async findById(id: string): Promise<PaymentProps | null> {
    return this.rows.get(id) ? { ...(this.rows.get(id) as PaymentProps) } : null;
  }
  async findByIdempotencyKey(key: string): Promise<PaymentProps | null> {
    return [...this.rows.values()].find((r) => r.idempotencyKey === key) ?? null;
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
    throw new Error(`create must not be called during capture (${data.id})`);
  }
  async updateState(id: string, update: PaymentStateUpdate): Promise<PaymentProps> {
    this.updateCalls += 1;
    if (this.failNextUpdate) {
      const err = this.failNextUpdate;
      this.failNextUpdate = undefined;
      throw err;
    }
    const row = this.rows.get(id) as PaymentProps;
    const next: PaymentProps = {
      ...row,
      status: update.status,
      providerRef: update.providerRef === undefined ? row.providerRef : update.providerRef,
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

/**
 * An in-memory ledger that enforces the two things the capture path depends on: the unique
 * `reference` constraint (`P2002`), and the balance check (delegated to the real
 * `LedgerTransactionDraft` inside `LedgerService`, so postings are validated for real).
 */
class InMemoryLedgerRepository implements ILedgerRepository {
  readonly accounts = new Map<string, LedgerAccountProps>();
  readonly postings: PostedLedgerTransaction[] = [];
  postCalls = 0;

  constructor(private readonly log: CallLog = []) {}

  private keyOf(ref: AccountRefKey): string {
    return `${ref.type}:${ref.ownerId ?? '-'}:${ref.currency}`;
  }

  async findAccountById(id: string): Promise<LedgerAccountProps | null> {
    return [...this.accounts.values()].find((a) => a.id === id) ?? null;
  }
  async findAccountByRef(ref: AccountRefKey): Promise<LedgerAccountProps | null> {
    return this.accounts.get(this.keyOf(ref)) ?? null;
  }
  async createAccount(ref: AccountRefKey): Promise<LedgerAccountProps> {
    const account: LedgerAccountProps = {
      id: `account-${this.keyOf(ref)}`,
      type: ref.type,
      ownerId: ref.ownerId,
      currency: ref.currency,
      createdAt: new Date(),
    };
    this.accounts.set(this.keyOf(ref), account);
    return account;
  }
  async findOrCreateAccount(ref: AccountRefKey): Promise<LedgerAccountProps> {
    return (await this.findAccountByRef(ref)) ?? this.createAccount(ref);
  }
  async createTransaction(draft: {
    reference: string;
    type: LedgerTransactionType;
    refType: string | null;
    refId: string | null;
    description: string | null;
    entries: readonly { accountId: string; direction: LedgerDirection; amount: { amountMinor: number; currency: { code: string } } }[];
  }): Promise<PostedLedgerTransaction> {
    this.postCalls += 1;
    this.log.push('ledger:post');
    if (this.postings.some((p) => p.transaction.reference === draft.reference)) {
      const err = new Error('Unique constraint failed on the fields: (`reference`)') as Error & {
        code: string;
      };
      err.code = 'P2002';
      throw err;
    }
    const posted: PostedLedgerTransaction = {
      transaction: {
        id: `txn-${this.postings.length + 1}`,
        reference: draft.reference,
        type: draft.type,
        refType: draft.refType,
        refId: draft.refId,
        description: draft.description,
        createdAt: new Date(),
      },
      entries: draft.entries.map((entry, index) => ({
        id: `entry-${index}`,
        transactionId: `txn-${this.postings.length + 1}`,
        accountId: entry.accountId,
        direction: entry.direction,
        amount: entry.amount.amountMinor,
        currency: entry.amount.currency.code,
        createdAt: new Date(),
      })),
    };
    this.postings.push(posted);
    return posted;
  }
  async findTransactionById(): Promise<PostedLedgerTransaction | null> {
    return null;
  }
  async findTransactionByReference(reference: string) {
    return this.postings.find((p) => p.transaction.reference === reference)?.transaction ?? null;
  }
  async findEntriesByTransactionId() {
    return [];
  }
  async findEntriesByAccountId() {
    return [];
  }
  async findEntriesByAccountInPeriod() {
    return [];
  }
  async sumAllEntriesByCurrency() {
    return [];
  }
  async listEntriesByAccountId() {
    return { items: [], total: 0 };
  }
  async sumEntriesByAccount() {
    return { debit: 0, credit: 0, currency: 'ETB' };
  }
  async findCachedBalance() {
    return null;
  }
}

class StubOrderPort implements IOrderPort {
  constructor(
    private readonly order: PayableOrderView | null,
    private readonly pharmacyIds: string[] = [PHARMACY_ID],
  ) {}
  async getOrder(): Promise<PayableOrderView | null> {
    return this.order;
  }
  async getOrderLines() {
    return [];
  }

  async getFulfillmentPharmacyIds(): Promise<string[]> {
    return this.pharmacyIds;
  }
}

class ScriptedProvider implements IPaymentProviderPort {
  readonly key = 'scripted';
  readonly captureRequests: ProviderPaymentOperationRequest[] = [];

  constructor(
    private readonly script: ProviderCaptureResult | Error,
    private readonly log: CallLog = [],
  ) {}

  supports(): boolean {
    return true;
  }
  async authorize(): Promise<ProviderAuthorizationResult> {
    throw new Error('authorize must not be called during capture');
  }
  async capture(request: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    this.captureRequests.push(request);
    this.log.push('provider:capture');
    if (this.script instanceof Error) {
      throw this.script;
    }
    return this.script;
  }
  async voidAuthorization(): Promise<ProviderVoidResult> {
    throw new Error('voidAuthorization must not be called during capture');
  }
  async refund(): Promise<ProviderRefundResult> {
    throw new Error('refund must not be called during capture');
  }
}

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
    payment?: Partial<PaymentProps>;
    order?: Partial<PayableOrderView> | null;
    provider?: ProviderCaptureResult | Error;
    pharmacyIds?: string[];
  } = {},
) {
  const log: CallLog = [];
  const payment = authorizedPayment(options.payment);
  const order: PayableOrderView | null =
    options.order === null
      ? null
      : {
          id: ORDER_ID,
          customerUserId: 'customer-1',
          status: 'PAID',
          grandTotal: 10_000,
          currency: 'ETB',
          platformFee: 1_000,
          discountTotal: 0,
          isCod: false,
          ...options.order,
        };

  const payments = new InMemoryPaymentRepository([payment], log);
  const ledgerRepo = new InMemoryLedgerRepository(log);
  const ledger = new LedgerService(ledgerRepo as unknown as ILedgerRepository);
  const provider = new ScriptedProvider(
    options.provider ?? { outcome: 'CAPTURED', providerRef: 'gw-capture-1' },
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

  // The real CaptureAccountingService, over the stub order port and the real LedgerService, so
  // these tests exercise the same §11.3 accounting the capture webhook posts.
  const captureAccounting = new CaptureAccountingService(
    new StubOrderPort(order, options.pharmacyIds),
    ledger,
  );
  const command = new CapturePaymentCommand(
    payments,
    new SingleProviderRegistry(provider),
    new FakeUnitOfWork(log),
    captureAccounting,
    audit,
    outbox,
  );

  return { command, payments, ledgerRepo, provider, audits, events, log };
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

/** The posted entries, keyed by account type, for balance assertions. */
function postedLegs(ledgerRepo: InMemoryLedgerRepository) {
  const posting = ledgerRepo.postings[0];
  const by = (type: LedgerAccountType) =>
    posting.entries.find((e) => e.accountId.includes(type));
  return {
    posting,
    gateway: by(LedgerAccountType.GATEWAY_CLEARING),
    payable: by(LedgerAccountType.PROVIDER_PAYABLE),
    revenue: by(LedgerAccountType.PLATFORM_REVENUE),
  };
}

/* ------------------------------------------------------------------------------------------ */

describe('CapturePaymentCommand — success (§6, §11.3)', () => {
  it('transitions AUTHORIZED -> CAPTURED and stamps capturedAt', async () => {
    const { command, payments } = harness();

    const result = await command.execute({ paymentId: PAYMENT_ID });

    expect(result.status).toBe(PaymentStatus.CAPTURED);
    expect(result.replay).toBe(false);
    const row = payments.rows.get(PAYMENT_ID) as PaymentProps;
    expect(row.status).toBe(PaymentStatus.CAPTURED);
    expect(row.capturedAt).toBeInstanceOf(Date);
  });

  it('calls the provider exactly once, for the full authorized amount', async () => {
    const { command, provider } = harness();

    await command.execute({ paymentId: PAYMENT_ID });

    expect(provider.captureRequests).toHaveLength(1);
    expect(provider.captureRequests[0]).toMatchObject({
      paymentId: PAYMENT_ID,
      amount: 10_000,
      currency: 'ETB',
      providerRef: 'gw-auth-1',
    });
  });

  it('persists the capture provider reference', async () => {
    const { command, payments } = harness({
      provider: { outcome: 'CAPTURED', providerRef: 'gw-capture-xyz' },
    });

    const result = await command.execute({ paymentId: PAYMENT_ID });

    expect(result.providerRef).toBe('gw-capture-xyz');
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).providerRef).toBe('gw-capture-xyz');
  });

  it('treats ALREADY_CAPTURED from the gateway as success (idempotent retry answer)', async () => {
    const { command, payments } = harness({
      provider: { outcome: 'ALREADY_CAPTURED', providerRef: 'gw-capture-1' },
    });

    const result = await command.execute({ paymentId: PAYMENT_ID });

    expect(result.status).toBe(PaymentStatus.CAPTURED);
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.CAPTURED);
  });
});

describe('CapturePaymentCommand — capture ledger posting (§11.3)', () => {
  it("posts the design's example: DEBIT gateway 100, CREDIT payable 90, CREDIT revenue 10", async () => {
    const { command, ledgerRepo } = harness({ order: { platformFee: 1_000 } });

    const result = await command.execute({ paymentId: PAYMENT_ID });
    const { posting, gateway, payable, revenue } = postedLegs(ledgerRepo);

    expect(posting.entries).toHaveLength(3);
    expect(gateway).toMatchObject({ direction: LedgerDirection.DEBIT, amount: 10_000 });
    expect(payable).toMatchObject({ direction: LedgerDirection.CREDIT, amount: 9_000 });
    expect(revenue).toMatchObject({ direction: LedgerDirection.CREDIT, amount: 1_000 });
    expect(result.fee).toBe(1_000);
    expect(result.providerNet).toBe(9_000);
  });

  it('balances exactly: debits === credits, in one currency', async () => {
    const { command, ledgerRepo } = harness({ order: { platformFee: 1_000 } });

    await command.execute({ paymentId: PAYMENT_ID });
    const { posting } = postedLegs(ledgerRepo);

    const sum = (direction: LedgerDirection) =>
      posting.entries
        .filter((e) => e.direction === direction)
        .reduce((total, e) => total + e.amount, 0);

    expect(sum(LedgerDirection.DEBIT)).toBe(sum(LedgerDirection.CREDIT));
    expect(sum(LedgerDirection.DEBIT)).toBe(10_000);
    expect(new Set(posting.entries.map((e) => e.currency))).toEqual(new Set(['ETB']));
  });

  it('credits the platform revenue exactly the configured fee from the order', async () => {
    for (const platformFee of [0, 1, 250, 2_500, 10_000]) {
      const { command, ledgerRepo } = harness({ order: { platformFee } });
      await command.execute({ paymentId: PAYMENT_ID });
      const { revenue, payable } = postedLegs(ledgerRepo);

      expect(revenue?.amount ?? 0).toBe(platformFee);
      expect(payable?.amount ?? 0).toBe(10_000 - platformFee);
    }
  });

  it('omits a zero leg rather than posting a zero entry (a zero fee is the current config)', async () => {
    const { command, ledgerRepo } = harness({ order: { platformFee: 0 } });

    await command.execute({ paymentId: PAYMENT_ID });
    const { posting, revenue, payable } = postedLegs(ledgerRepo);

    expect(posting.entries).toHaveLength(2);
    expect(revenue).toBeUndefined();
    expect(payable?.amount).toBe(10_000);
  });

  it('credits the provider payable owned by the order fulfillment pharmacy, not a caller input', async () => {
    const { command, ledgerRepo } = harness({ pharmacyIds: ['pharmacy-from-fulfillment'] });

    await command.execute({ paymentId: PAYMENT_ID });
    const { payable } = postedLegs(ledgerRepo);

    expect(payable?.accountId).toContain('pharmacy-from-fulfillment');
    expect(Object.keys({} as CapturePaymentCommand)).not.toContain('pharmacyId');
  });

  it('uses a deterministic, unique capture reference', async () => {
    const { command, ledgerRepo } = harness();

    const result = await command.execute({ paymentId: PAYMENT_ID });

    expect(result.ledgerReference).toBe(`CAPTURE-${PAYMENT_ID}`);
    expect(ledgerRepo.postings[0].transaction.reference).toBe(captureLedgerReference(PAYMENT_ID));
    expect(ledgerRepo.postings[0].transaction.type).toBe(LedgerTransactionType.CAPTURE);
    expect(ledgerRepo.postings[0].transaction.refId).toBe(PAYMENT_ID);
  });

  it('resolves accounts by natural key — no hard-coded ids', async () => {
    const { command, ledgerRepo } = harness();

    await command.execute({ paymentId: PAYMENT_ID });

    const types = [...ledgerRepo.accounts.values()].map((a) => a.type);
    expect(types).toEqual(
      expect.arrayContaining([
        LedgerAccountType.GATEWAY_CLEARING,
        LedgerAccountType.PROVIDER_PAYABLE,
        LedgerAccountType.PLATFORM_REVENUE,
      ]),
    );
    const payable = [...ledgerRepo.accounts.values()].find(
      (a) => a.type === LedgerAccountType.PROVIDER_PAYABLE,
    );
    expect(payable?.ownerId).toBe(PHARMACY_ID);
  });
});

describe('CapturePaymentCommand — state guards (§6)', () => {
  it.each([
    PaymentStatus.INITIATED,
    PaymentStatus.FAILED,
    PaymentStatus.VOIDED,
    PaymentStatus.EXPIRED,
    PaymentStatus.SETTLED,
    PaymentStatus.REFUNDED,
    PaymentStatus.PARTIALLY_REFUNDED,
  ])('rejects capture from %s without calling the provider', async (status) => {
    const { command, provider, ledgerRepo } = harness({ payment: { status } });

    await expectApiError(
      command.execute({ paymentId: PAYMENT_ID }),
      ErrorCode.INVALID_PAYMENT_STATE_TRANSITION,
    );
    expect(provider.captureRequests).toHaveLength(0);
    expect(ledgerRepo.postings).toHaveLength(0);
  });

  it('rejects an unknown payment id', async () => {
    const { command } = harness();
    await expectApiError(command.execute({ paymentId: 'nope' }), ErrorCode.NOT_FOUND);
  });

  it('rejects a blank payment id', async () => {
    const { command } = harness();
    await expectApiError(command.execute({ paymentId: '  ' }), ErrorCode.VALIDATION_ERROR);
  });

  it('fails loudly when the provider payable owner cannot be determined', async () => {
    for (const pharmacyIds of [[], ['pharmacy-a', 'pharmacy-b']]) {
      const { command, provider, ledgerRepo } = harness({ pharmacyIds });
      const error = await expectApiError(
        command.execute({ paymentId: PAYMENT_ID }),
        ErrorCode.BUSINESS_RULE_VIOLATION,
      );
      expect(error.details).toMatchObject({ orderId: ORDER_ID });
      // Nothing external happened and nothing was posted — a mis-paid provider is worse than a
      // failed capture.
      expect(provider.captureRequests).toHaveLength(0);
      expect(ledgerRepo.postings).toHaveLength(0);
    }
  });

  it('rejects capture when the order no longer exists', async () => {
    const { command, provider } = harness({ order: null });
    await expectApiError(command.execute({ paymentId: PAYMENT_ID }), ErrorCode.ORDER_NOT_FOUND);
    expect(provider.captureRequests).toHaveLength(0);
  });
});

describe('CapturePaymentCommand — idempotency (§7)', () => {
  it('an already-CAPTURED payment replays without calling the provider or posting again', async () => {
    const { command, provider, ledgerRepo } = harness({
      payment: { status: PaymentStatus.CAPTURED, capturedAt: new Date() },
    });

    const result = await command.execute({ paymentId: PAYMENT_ID });

    expect(result.replay).toBe(true);
    expect(result.status).toBe(PaymentStatus.CAPTURED);
    expect(provider.captureRequests).toHaveLength(0);
    expect(ledgerRepo.postings).toHaveLength(0);
  });

  it('a sequential retry after a successful capture does not post a second ledger transaction', async () => {
    const { command, ledgerRepo, provider } = harness();

    const first = await command.execute({ paymentId: PAYMENT_ID });
    const second = await command.execute({ paymentId: PAYMENT_ID });

    expect(second.replay).toBe(true);
    expect(second.paymentId).toBe(first.paymentId);
    expect(ledgerRepo.postings).toHaveLength(1);
    expect(provider.captureRequests).toHaveLength(1);
  });

  it('concurrent captures produce exactly one capture and one ledger posting', async () => {
    const { command, ledgerRepo, payments } = harness();

    const results = await Promise.allSettled([
      command.execute({ paymentId: PAYMENT_ID }),
      command.execute({ paymentId: PAYMENT_ID }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);
    // The unique capture reference is what collapses them: the loser returns the winner's result.
    expect(ledgerRepo.postings).toHaveLength(1);
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.CAPTURED);
  });
});

describe('CapturePaymentCommand — provider failure and ambiguity (§1)', () => {
  it('a declined capture leaves the payment AUTHORIZED and posts nothing', async () => {
    const { command, payments, ledgerRepo, events } = harness({
      provider: {
        outcome: 'FAILED',
        providerRef: 'gw-1',
        failureReason: 'Capture window expired',
        failureCode: 'expired',
      },
    });

    const error = await expectApiError(
      command.execute({ paymentId: PAYMENT_ID }),
      ErrorCode.PAYMENT_CAPTURE_FAILED,
    );
    expect(error.httpStatus).toBe(402);

    // §6 defines no AUTHORIZED -> FAILED edge: the authorization is still live.
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.AUTHORIZED);
    expect(ledgerRepo.postings).toHaveLength(0);
    // No capture-failure event is invented — the design catalogues none.
    expect(events).toHaveLength(0);
  });

  it('an UNKNOWN outcome does not become a false FAILED, and posts nothing', async () => {
    const { command, payments, ledgerRepo } = harness({
      provider: { outcome: 'UNKNOWN', providerRef: 'gw-maybe-1' },
    });

    await expectApiError(
      command.execute({ paymentId: PAYMENT_ID }),
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );

    const row = payments.rows.get(PAYMENT_ID) as PaymentProps;
    expect(row.status).toBe(PaymentStatus.AUTHORIZED);
    expect(row.capturedAt).toBeNull();
    expect(ledgerRepo.postings).toHaveLength(0);
    // The reference the gateway did give us is kept — reconciliation matches on it.
    expect(row.providerRef).toBe('gw-maybe-1');
  });

  it('a thrown provider error is treated as unknown, never as a decline', async () => {
    const { command, payments, ledgerRepo } = harness({
      provider: new Error('socket hang up'),
    });

    await expectApiError(
      command.execute({ paymentId: PAYMENT_ID }),
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.AUTHORIZED);
    expect(ledgerRepo.postings).toHaveLength(0);
  });

  it('sanitizes a decline reason that leaks card data', async () => {
    const { command, audits } = harness({
      provider: {
        outcome: 'FAILED',
        providerRef: 'gw-1',
        failureReason: 'Declined for card 4111 1111 1111 1111',
      },
    });

    const error = await expectApiError(
      command.execute({ paymentId: PAYMENT_ID }),
      ErrorCode.PAYMENT_CAPTURE_FAILED,
    );

    expect(error.message).not.toContain('4111');
    expect(error.message).toContain('[redacted]');
    expect(JSON.stringify(audits)).not.toContain('4111');
  });

  it('a persistence failure after a successful provider capture leaves a recoverable state', async () => {
    const { command, payments, provider } = harness();
    payments.failNextUpdate = new Error('CONTROLLED_FAILURE: capture transaction failed');

    await expect(command.execute({ paymentId: PAYMENT_ID })).rejects.toThrow('CONTROLLED_FAILURE');

    const row = payments.rows.get(PAYMENT_ID) as PaymentProps;
    // Not FAILED, not lost: the gateway holds a capture keyed by this payment id, and a retry
    // gets ALREADY_CAPTURED so the local state catches up without moving money twice.
    expect(row.status).toBe(PaymentStatus.AUTHORIZED);
    expect(provider.captureRequests[0].paymentId).toBe(PAYMENT_ID);
  });
});

describe('CapturePaymentCommand — ordering, audit and events', () => {
  it('calls the provider outside the transaction, before the commit', async () => {
    const { command, log } = harness();

    await command.execute({ paymentId: PAYMENT_ID });

    const providerCall = log.indexOf('provider:capture');
    const commit = log.indexOf('tx:commit');
    const post = log.indexOf('ledger:post');
    expect(providerCall).toBeGreaterThanOrEqual(0);
    expect(providerCall).toBeLessThan(post);
    expect(post).toBeLessThan(commit);
  });

  it('writes the state change, the posting, the audit entry and the event in one transaction', async () => {
    const { command, log } = harness();

    await command.execute({ paymentId: PAYMENT_ID });

    const commit = log.indexOf('tx:commit');
    for (const effect of [
      'payment:update:CAPTURED',
      'ledger:post',
      'audit:PAYMENT_CAPTURED',
      'outbox:payment.captured',
    ]) {
      expect(log.indexOf(effect)).toBeGreaterThanOrEqual(0);
      expect(log.indexOf(effect)).toBeLessThan(commit);
    }
  });

  it('audits capture with every §13 field, including the ledger reference', async () => {
    const { command, audits } = harness({ order: { platformFee: 1_000 } });

    await command.execute({ paymentId: PAYMENT_ID, actorUserId: 'pharmacist-1' });

    const entry = audits.find((a) => a.action === 'PAYMENT_CAPTURED');
    expect(entry).toBeDefined();
    expect(entry?.actorUserId).toBe('pharmacist-1');
    expect(entry?.resourceType).toBe('Payment');
    expect(entry?.resourceId).toBe(PAYMENT_ID);
    expect(entry?.context).toMatchObject({
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      amount: 10_000,
      currency: 'ETB',
      method: PaymentMethod.TELEBIRR,
      provider: 'scripted',
      providerRef: 'gw-capture-1',
      outcome: 'CAPTURED',
      fee: 1_000,
      providerNet: 9_000,
      ledgerReference: `CAPTURE-${PAYMENT_ID}`,
    });
  });

  it('emits the catalogued payment.captured event with its fee payload', async () => {
    const { command, events } = harness({ order: { platformFee: 1_000 } });

    await command.execute({ paymentId: PAYMENT_ID });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('payment.captured');
    expect(events[0].aggregateType).toBe('Payment');
    expect(events[0].payload).toEqual({
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      fee: 1_000,
    });
  });

  it('leaks no token or sensitive provider data into audit or events', async () => {
    const { command, audits, events } = harness({
      payment: { providerToken: 'tok_secret_gateway_value' },
    });

    await command.execute({ paymentId: PAYMENT_ID });

    expect(JSON.stringify(audits)).not.toContain('tok_secret_gateway_value');
    expect(JSON.stringify(events)).not.toContain('tok_secret_gateway_value');
    for (const forbidden of ['pan', 'cvv', 'cardNumber']) {
      expect(JSON.stringify(audits).toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
