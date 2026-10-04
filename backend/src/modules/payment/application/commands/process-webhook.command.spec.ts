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
import {
  IWebhookRepository,
  NewProviderWebhookData,
  ProviderWebhookSnapshot,
} from '../../domain/repositories/webhook.repository';
import { LedgerService } from '../../domain/services/ledger.service';
import { AccountRefKey } from '../../domain/value-objects/account-ref.vo';
import { IOrderPort, PayableOrderView } from '../ports/outbound/order.port';
import {
  IPaymentWebhookPort,
  IPaymentWebhookRegistry,
} from '../ports/outbound/payment-webhook.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { CaptureAccountingService } from '../services/capture-accounting.service';
import {
  NormalizedWebhookEvent,
  RawWebhookDelivery,
  WebhookEventType,
} from '../webhooks/normalized-webhook-event';
import { ProcessWebhookCommand, WebhookOutcome } from './process-webhook.command';

const PAYMENT_ID = 'payment-1';
const ORDER_ID = 'order-1';
const PHARMACY_ID = 'pharmacy-1';
const PROVIDER = 'mock';

type CallLog = string[];

function paymentRow(overrides: Partial<PaymentProps> = {}): PaymentProps {
  const now = new Date('2026-09-09T09:00:00.000Z');
  return {
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    customerUserId: 'customer-1',
    method: PaymentMethod.TELEBIRR,
    status: PaymentStatus.INITIATED,
    amount: 10_000,
    currency: 'ETB',
    originalAmount: null,
    originalCurrency: null,
    fxRate: null,
    fxSource: null,
    provider: PROVIDER,
    providerRef: null,
    providerToken: null,
    idempotencyKey: 'pay-order-1-attempt-1',
    authorizedAt: null,
    capturedAt: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class InMemoryPaymentRepository implements IPaymentRepository {
  readonly rows = new Map<string, PaymentProps>();
  constructor(seed: PaymentProps[] = [], private readonly log: CallLog = []) {
    for (const row of seed) this.rows.set(row.id, row);
  }
  async findById(id: string): Promise<PaymentProps | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async findByIdempotencyKey(): Promise<PaymentProps | null> {
    return null;
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
  async findStale(): Promise<PaymentProps[]> {
    return [];
  }
  async create(data: NewPaymentData): Promise<PaymentProps> {
    throw new Error(`create must not be called by a webhook (${data.id})`);
  }
  async updateState(id: string, update: PaymentStateUpdate): Promise<PaymentProps> {
    const row = this.rows.get(id) as PaymentProps;
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

/** Models the real `@@unique([provider, eventId])` constraint by throwing `P2002`. */
class InMemoryWebhookRepository implements IWebhookRepository {
  readonly rows: ProviderWebhookSnapshot[] = [];
  recordCalls = 0;
  constructor(private readonly log: CallLog = []) {}

  /** Synchronous, so check-and-insert below cannot interleave — modelling the real index. */
  private lookup(provider: string, eventId: string): ProviderWebhookSnapshot | null {
    return this.rows.find((r) => r.provider === provider && r.eventId === eventId) ?? null;
  }
  async findByProviderEvent(
    provider: string,
    eventId: string,
  ): Promise<ProviderWebhookSnapshot | null> {
    return this.lookup(provider, eventId);
  }
  async record(data: NewProviderWebhookData): Promise<ProviderWebhookSnapshot> {
    this.recordCalls += 1;
    // No `await` between the duplicate check and the insert: a real unique index decides this
    // atomically, and a double that yields here would let concurrent deliveries all "win".
    if (this.lookup(data.provider, data.eventId)) {
      const err = new Error('Unique constraint failed on the fields: (`provider`,`eventId`)') as
        Error & { code: string };
      err.code = 'P2002';
      throw err;
    }
    const row: ProviderWebhookSnapshot = {
      id: `webhook-${this.rows.length + 1}`,
      provider: data.provider,
      eventId: data.eventId,
      payload: data.payload,
      processedAt: data.processedAt ?? null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    this.log.push('webhook:record');
    return row;
  }
  async markProcessed(id: string, processedAt: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.processedAt = processedAt;
  }
  async findUnprocessed(limit: number): Promise<ProviderWebhookSnapshot[]> {
    return this.rows.filter((r) => r.processedAt === null).slice(0, limit);
  }
}

class InMemoryLedgerRepository implements ILedgerRepository {
  readonly accounts = new Map<string, LedgerAccountProps>();
  readonly postings: PostedLedgerTransaction[] = [];
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
    entries: readonly {
      accountId: string;
      direction: LedgerDirection;
      amount: { amountMinor: number; currency: { code: string } };
    }[];
  }): Promise<PostedLedgerTransaction> {
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
  constructor(private readonly order: PayableOrderView | null) {}
  async getOrder(): Promise<PayableOrderView | null> {
    return this.order;
  }
  async getOrderLines() {
    return [];
  }

  async getFulfillmentPharmacyIds(): Promise<string[]> {
    return [PHARMACY_ID];
  }
}

/** A webhook adapter double: scripted verification result and scripted normalized event. */
class ScriptedWebhookAdapter implements IPaymentWebhookPort {
  readonly provider = PROVIDER;
  verifyCalls = 0;
  normalizeCalls = 0;
  constructor(
    private readonly event: NormalizedWebhookEvent | Error,
    private readonly verifyError: Error | null = null,
    private readonly log: CallLog = [],
  ) {}
  async verify(): Promise<void> {
    this.verifyCalls += 1;
    this.log.push('webhook:verify');
    if (this.verifyError) throw this.verifyError;
  }
  async normalize(): Promise<NormalizedWebhookEvent> {
    this.normalizeCalls += 1;
    if (this.event instanceof Error) throw this.event;
    return this.event;
  }
}

class StubRegistry implements IPaymentWebhookRegistry {
  constructor(private readonly adapter: IPaymentWebhookPort | null) {}
  forProvider(provider: string): IPaymentWebhookPort | null {
    return this.adapter && this.adapter.provider === provider ? this.adapter : null;
  }
  providers(): string[] {
    return this.adapter ? [this.adapter.provider] : [];
  }
}

/**
 * Models a real transaction closely enough for the behaviour under test: it **rolls back** on
 * failure. Without that, a webhook row inserted before a mid-transaction failure would survive in
 * the double but not in Postgres, and the test would assert the opposite of production.
 */
class FakeUnitOfWork implements IUnitOfWork {
  /** Serializes transactions, so one never observes another's uncommitted state. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly log: CallLog = [],
    private readonly snapshot: () => () => void = () => () => undefined,
  ) {}

  run<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.runIsolated(work));
    // Keep the chain alive regardless of this transaction's outcome.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async runIsolated<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    const rollback = this.snapshot();
    try {
      const result = await work({ tx: true });
      this.log.push('tx:commit');
      return result;
    } catch (err) {
      rollback();
      this.log.push('tx:rollback');
      throw err;
    }
  }
}

interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  context?: Record<string, unknown> | null;
}

function normalizedEvent(overrides: Partial<NormalizedWebhookEvent> = {}): NormalizedWebhookEvent {
  return {
    provider: PROVIDER,
    eventId: 'evt-1',
    type: WebhookEventType.AuthorizationSucceeded,
    paymentId: PAYMENT_ID,
    providerRef: 'gw-ref-1',
    occurredAt: new Date('2026-09-09T10:00:00.000Z'),
    failureReason: null,
    failureCode: null,
    ...overrides,
  };
}

function delivery(overrides: Partial<RawWebhookDelivery> = {}): RawWebhookDelivery {
  return {
    provider: PROVIDER,
    rawBody: JSON.stringify({ id: 'evt-1', type: 'payment.authorized' }),
    headers: { 'x-payment-signature': 'sig' },
    ...overrides,
  };
}

function harness(
  options: {
    payment?: Partial<PaymentProps> | null;
    event?: NormalizedWebhookEvent | Error;
    verifyError?: Error | null;
    order?: Partial<PayableOrderView>;
    noAdapter?: boolean;
  } = {},
) {
  const log: CallLog = [];
  const payments = new InMemoryPaymentRepository(
    options.payment === null ? [] : [paymentRow(options.payment)],
    log,
  );
  const webhooks = new InMemoryWebhookRepository(log);
  const ledgerRepo = new InMemoryLedgerRepository(log);
  const ledger = new LedgerService(ledgerRepo as unknown as ILedgerRepository);
  const order: PayableOrderView = {
    id: ORDER_ID,
    customerUserId: 'customer-1',
    status: 'PENDING_PAYMENT',
    grandTotal: 10_000,
    currency: 'ETB',
    platformFee: 1_000,
    discountTotal: 0,
    isCod: false,
    ...options.order,
  };
  const captureAccounting = new CaptureAccountingService(new StubOrderPort(order), ledger);
  const adapter = new ScriptedWebhookAdapter(
    options.event ?? normalizedEvent(),
    options.verifyError ?? null,
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

  const takeSnapshot = () => {
    const webhookRows = [...webhooks.rows];
    const paymentRows = new Map([...payments.rows].map(([k, v]) => [k, { ...v }]));
    const postings = [...ledgerRepo.postings];
    return () => {
      webhooks.rows.length = 0;
      webhooks.rows.push(...webhookRows);
      payments.rows.clear();
      for (const [k, v] of paymentRows) payments.rows.set(k, v);
      ledgerRepo.postings.length = 0;
      ledgerRepo.postings.push(...postings);
    };
  };

  const command = new ProcessWebhookCommand(
    new StubRegistry(options.noAdapter ? null : adapter),
    payments,
    webhooks,
    new FakeUnitOfWork(log, takeSnapshot),
    captureAccounting,
    audit,
    outbox,
  );

  return { command, payments, webhooks, ledgerRepo, adapter, audits, events, log };
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

describe('ProcessWebhookCommand — authorization outcomes (§7)', () => {
  it('advances INITIATED -> AUTHORIZED, persists the provider reference, emits the event', async () => {
    const { command, payments, events, ledgerRepo } = harness();

    const result = await command.execute(delivery());

    expect(result.outcome).toBe(WebhookOutcome.Advanced);
    expect(result.status).toBe(PaymentStatus.AUTHORIZED);
    expect(result.accepted).toBe(true);

    const row = payments.rows.get(PAYMENT_ID) as PaymentProps;
    expect(row.status).toBe(PaymentStatus.AUTHORIZED);
    expect(row.providerRef).toBe('gw-ref-1');
    expect(row.authorizedAt).toBeInstanceOf(Date);

    expect(events.map((e) => e.type)).toEqual(['payment.authorized']);
    expect(events[0].payload).toEqual({ paymentId: PAYMENT_ID, orderId: ORDER_ID });
    // An authorization is a hold at the gateway — it moves no platform money (§7).
    expect(ledgerRepo.postings).toHaveLength(0);
  });

  it('advances INITIATED -> FAILED with a sanitized reason and the catalogued event', async () => {
    const { command, payments, events, audits } = harness({
      event: normalizedEvent({
        type: WebhookEventType.AuthorizationFailed,
        failureReason: 'Declined for card 4111 1111 1111 1111',
        failureCode: 'do_not_honor',
      }),
    });

    const result = await command.execute(delivery());

    expect(result.status).toBe(PaymentStatus.FAILED);
    const row = payments.rows.get(PAYMENT_ID) as PaymentProps;
    expect(row.status).toBe(PaymentStatus.FAILED);
    expect(row.failureReason).not.toContain('4111');
    expect(row.failureReason).toContain('[redacted]');

    expect(events.map((e) => e.type)).toEqual(['payment.failed']);
    expect(JSON.stringify(events[0].payload)).not.toContain('4111');
    expect(JSON.stringify(audits)).not.toContain('4111');
  });

  it('locates the payment by provider reference when the callback omits our payment id', async () => {
    const { command, payments } = harness({
      payment: { providerRef: 'gw-known-ref' },
      event: normalizedEvent({ paymentId: null, providerRef: 'gw-known-ref' }),
    });

    const result = await command.execute(delivery());

    expect(result.paymentId).toBe(PAYMENT_ID);
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.AUTHORIZED);
  });
});

describe('ProcessWebhookCommand — capture (§6)', () => {
  it('advances AUTHORIZED -> CAPTURED and posts the balanced three-leg transaction', async () => {
    const { command, payments, ledgerRepo, events } = harness({
      payment: { status: PaymentStatus.AUTHORIZED, providerRef: 'gw-auth-1' },
      event: normalizedEvent({
        type: WebhookEventType.CaptureSucceeded,
        providerRef: 'gw-capture-1',
      }),
    });

    const result = await command.execute(delivery());

    expect(result.status).toBe(PaymentStatus.CAPTURED);
    const row = payments.rows.get(PAYMENT_ID) as PaymentProps;
    expect(row.status).toBe(PaymentStatus.CAPTURED);
    expect(row.capturedAt).toBeInstanceOf(Date);
    expect(row.providerRef).toBe('gw-capture-1');

    expect(ledgerRepo.postings).toHaveLength(1);
    const posting = ledgerRepo.postings[0];
    expect(posting.transaction.reference).toBe(`CAPTURE-${PAYMENT_ID}`);
    expect(posting.entries).toHaveLength(3);

    const leg = (type: LedgerAccountType) =>
      posting.entries.find((e) => e.accountId.includes(type));
    expect(leg(LedgerAccountType.GATEWAY_CLEARING)).toMatchObject({
      direction: LedgerDirection.DEBIT,
      amount: 10_000,
    });
    expect(leg(LedgerAccountType.PROVIDER_PAYABLE)).toMatchObject({
      direction: LedgerDirection.CREDIT,
      amount: 9_000,
    });
    expect(leg(LedgerAccountType.PLATFORM_REVENUE)).toMatchObject({
      direction: LedgerDirection.CREDIT,
      amount: 1_000,
    });

    const sum = (d: LedgerDirection) =>
      posting.entries.filter((e) => e.direction === d).reduce((t, e) => t + e.amount, 0);
    expect(sum(LedgerDirection.DEBIT)).toBe(sum(LedgerDirection.CREDIT));

    expect(events.map((e) => e.type)).toEqual(['payment.captured']);
    expect(events[0].payload).toEqual({
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      fee: 1_000,
    });
  });

  it('credits the provider payable owned by the order fulfillment, never a payload field', async () => {
    const { command, ledgerRepo } = harness({
      payment: { status: PaymentStatus.AUTHORIZED },
      event: normalizedEvent({ type: WebhookEventType.CaptureSucceeded }),
    });

    await command.execute(delivery());
    const payable = ledgerRepo.postings[0].entries.find((e) =>
      e.accountId.includes(LedgerAccountType.PROVIDER_PAYABLE),
    );
    expect(payable?.accountId).toContain(PHARMACY_ID);
  });
});

describe('ProcessWebhookCommand — deduplication and replay (§4, §11)', () => {
  it('a duplicate delivery is a no-op: one effect, one event, one webhook row', async () => {
    const { command, payments, webhooks, events, ledgerRepo } = harness();

    const first = await command.execute(delivery());
    const second = await command.execute(delivery());

    expect(first.outcome).toBe(WebhookOutcome.Advanced);
    expect(second.outcome).toBe(WebhookOutcome.Duplicate);
    expect(second.accepted).toBe(true);

    expect(webhooks.rows).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(ledgerRepo.postings).toHaveLength(0);
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.AUTHORIZED);
  });

  it('a duplicate capture delivery does not post a second capture transaction', async () => {
    const { command, ledgerRepo, webhooks } = harness({
      payment: { status: PaymentStatus.AUTHORIZED },
      event: normalizedEvent({ type: WebhookEventType.CaptureSucceeded }),
    });

    await command.execute(delivery());
    const second = await command.execute(delivery());

    expect(second.outcome).toBe(WebhookOutcome.Duplicate);
    expect(ledgerRepo.postings).toHaveLength(1);
    expect(webhooks.rows).toHaveLength(1);
  });

  it('concurrent deliveries of one event produce exactly one effect', async () => {
    const { command, webhooks, events, payments } = harness();

    const results = await Promise.all([
      command.execute(delivery()),
      command.execute(delivery()),
      command.execute(delivery()),
    ]);

    expect(results.every((r) => r.accepted)).toBe(true);
    expect(results.filter((r) => r.outcome === WebhookOutcome.Advanced)).toHaveLength(1);
    expect(results.filter((r) => r.outcome === WebhookOutcome.Duplicate)).toHaveLength(2);
    expect(webhooks.rows).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.AUTHORIZED);
  });

  it('deduplicates per provider: the same event id from another gateway is distinct', async () => {
    const { webhooks } = harness();
    await webhooks.record({ provider: 'mock', eventId: 'evt-1', payload: {} });
    await expect(
      webhooks.record({ provider: 'other-gateway', eventId: 'evt-1', payload: {} }),
    ).resolves.toMatchObject({ provider: 'other-gateway' });
    await expect(
      webhooks.record({ provider: 'mock', eventId: 'evt-1', payload: {} }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('ProcessWebhookCommand — races with local commands (§11)', () => {
  it('an authorization callback arriving after the local authorization is already applied', async () => {
    const { command, events, audits, payments } = harness({
      payment: { status: PaymentStatus.AUTHORIZED, providerRef: 'gw-local' },
    });

    const result = await command.execute(delivery());

    expect(result.outcome).toBe(WebhookOutcome.AlreadyApplied);
    expect(result.accepted).toBe(true);
    expect(events).toHaveLength(0);
    expect(audits.map((a) => a.action)).toContain('PAYMENT_WEBHOOK_ALREADY_APPLIED');
    // The local command's reference is not overwritten by the late callback.
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).providerRef).toBe('gw-local');
  });

  it('a capture callback arriving after the local capture posts nothing further', async () => {
    const { command, ledgerRepo, events } = harness({
      payment: { status: PaymentStatus.CAPTURED, capturedAt: new Date() },
      event: normalizedEvent({ type: WebhookEventType.CaptureSucceeded }),
    });

    const result = await command.execute(delivery());

    expect(result.outcome).toBe(WebhookOutcome.AlreadyApplied);
    expect(ledgerRepo.postings).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('an authorization callback arriving after capture is late news, not a contradiction', async () => {
    // §6's progression is linear, so CAPTURED already implies AUTHORIZED happened.
    const { command, events } = harness({ payment: { status: PaymentStatus.CAPTURED } });

    const result = await command.execute(delivery());

    expect(result.outcome).toBe(WebhookOutcome.AlreadyApplied);
    expect(events).toHaveLength(0);
  });

  it('a repeated authorization-failure callback on a FAILED payment is already applied', async () => {
    const { command, events } = harness({
      payment: { status: PaymentStatus.FAILED, failureReason: 'Declined' },
      event: normalizedEvent({ type: WebhookEventType.AuthorizationFailed }),
    });

    const result = await command.execute(delivery());

    expect(result.outcome).toBe(WebhookOutcome.AlreadyApplied);
    expect(events).toHaveLength(0);
  });
});

describe('ProcessWebhookCommand — illegal and unknown events (§5, §8)', () => {
  it('rejects a contradictory event through the existing state policy', async () => {
    // Authorization *failed*, for money already captured. Not a late delivery — a conflict.
    const { command, payments, ledgerRepo } = harness({
      payment: { status: PaymentStatus.CAPTURED },
      event: normalizedEvent({ type: WebhookEventType.AuthorizationFailed }),
    });

    await expectApiError(
      command.execute(delivery()),
      ErrorCode.INVALID_PAYMENT_STATE_TRANSITION,
    );

    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.CAPTURED);
    expect(ledgerRepo.postings).toHaveLength(0);
  });

  it('preserves a failed delivery as an unprocessed row for reconciliation', async () => {
    const { command, webhooks } = harness({
      payment: { status: PaymentStatus.CAPTURED },
      event: normalizedEvent({ type: WebhookEventType.AuthorizationFailed }),
    });

    await expect(command.execute(delivery())).rejects.toBeInstanceOf(ApiException);

    expect(webhooks.rows).toHaveLength(1);
    expect(webhooks.rows[0].processedAt).toBeNull();
  });

  it('an UNKNOWN event never becomes FAILED — it is recorded and deferred', async () => {
    const { command, payments, events, audits, webhooks, ledgerRepo } = harness({
      event: normalizedEvent({ type: WebhookEventType.Unknown }),
    });

    const result = await command.execute(delivery());

    expect(result.outcome).toBe(WebhookOutcome.Deferred);
    expect(result.accepted).toBe(true);
    // The payment is untouched and every bit as recoverable as before.
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.INITIATED);
    expect(events).toHaveLength(0);
    expect(ledgerRepo.postings).toHaveLength(0);
    expect(audits.map((a) => a.action)).toContain('PAYMENT_WEBHOOK_DEFERRED');
    // Recorded, so reconciliation can see it.
    expect(webhooks.rows).toHaveLength(1);
    expect(webhooks.rows[0].processedAt).not.toBeNull();
  });

  it('a callback matching no payment is deferred, not failed', async () => {
    const { command, events, webhooks } = harness({
      payment: null,
      event: normalizedEvent({ paymentId: 'nobody', providerRef: null }),
    });

    const result = await command.execute(delivery());

    expect(result.outcome).toBe(WebhookOutcome.Deferred);
    expect(result.paymentId).toBeNull();
    expect(events).toHaveLength(0);
    expect(webhooks.rows).toHaveLength(1);
  });
});

describe('ProcessWebhookCommand — signature and payload validation (§2)', () => {
  it('rejects an invalid signature before anything is read or written', async () => {
    const invalid = new ApiException(
      ErrorCode.WEBHOOK_SIGNATURE_INVALID,
      'Webhook signature verification failed.',
    );
    const { command, webhooks, adapter, audits } = harness({ verifyError: invalid });

    await expectApiError(command.execute(delivery()), ErrorCode.WEBHOOK_SIGNATURE_INVALID);

    expect(adapter.normalizeCalls).toBe(0);
    expect(webhooks.rows).toHaveLength(0);
    const security = audits.find((a) => a.action === 'PAYMENT_WEBHOOK_SIGNATURE_INVALID');
    expect(security).toBeDefined();
    // No signature, secret or body in the security audit context (§12).
    expect(Object.keys(security?.context ?? {})).toEqual(['provider']);
  });

  it('verifies before normalizing, always', async () => {
    const { command, log } = harness();
    await command.execute(delivery());
    expect(log.indexOf('webhook:verify')).toBe(0);
  });

  it('refuses a callback for an unknown provider', async () => {
    const { command, webhooks } = harness({ noAdapter: true });
    await expectApiError(command.execute(delivery()), ErrorCode.VALIDATION_ERROR);
    expect(webhooks.rows).toHaveLength(0);
  });

  it.each([
    ['a missing event id', normalizedEvent({ eventId: '  ' })],
    ['a provider mismatch', normalizedEvent({ provider: 'someone-else' })],
    ['no payment id and no provider reference', normalizedEvent({ paymentId: null, providerRef: null })],
    ['an invalid occurredAt', normalizedEvent({ occurredAt: new Date('nope') })],
  ])('rejects a malformed normalized event: %s', async (_name, event) => {
    const { command, webhooks } = harness({ event });
    await expectApiError(command.execute(delivery()), ErrorCode.VALIDATION_ERROR);
    expect(webhooks.rows).toHaveLength(0);
  });
});

describe('ProcessWebhookCommand — atomicity, audit and payload handling', () => {
  it('commits the webhook row, the transition, the audit entry and the event together', async () => {
    const { command, log } = harness();

    await command.execute(delivery());

    const commit = log.indexOf('tx:commit');
    for (const effect of [
      'webhook:record',
      'payment:update:AUTHORIZED',
      'audit:PAYMENT_AUTHORIZED',
      'outbox:payment.authorized',
    ]) {
      expect(log.indexOf(effect)).toBeGreaterThanOrEqual(0);
      expect(log.indexOf(effect)).toBeLessThan(commit);
    }
  });

  it('marks the webhook processed only as part of that same commit', async () => {
    const { command, webhooks } = harness();
    await command.execute(delivery());
    expect(webhooks.rows[0].processedAt).toBeInstanceOf(Date);
  });

  it('audits the advancement with the source and the gateway event id, and no payload', async () => {
    const { command, audits } = harness();

    await command.execute(delivery());

    const entry = audits.find((a) => a.action === 'PAYMENT_AUTHORIZED');
    expect(entry?.context).toMatchObject({
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      amount: 10_000,
      currency: 'ETB',
      source: 'webhook',
      provider: PROVIDER,
      eventId: 'evt-1',
      outcome: 'AUTHORIZED',
    });
    expect(JSON.stringify(audits)).not.toContain('x-payment-signature');
    expect(JSON.stringify(audits)).not.toContain('rawBody');
  });

  it('stores the raw payload only on the webhook row, never in an event', async () => {
    const { command, webhooks, events } = harness();

    await command.execute(
      delivery({ rawBody: JSON.stringify({ id: 'evt-1', secretish: 'raw-provider-blob' }) }),
    );

    expect(JSON.stringify(webhooks.rows[0].payload)).toContain('raw-provider-blob');
    expect(JSON.stringify(events)).not.toContain('raw-provider-blob');
  });

  it('keeps an unparseable body as evidence rather than dropping it', async () => {
    const { command, webhooks } = harness();
    await command.execute(delivery({ rawBody: 'not json at all' }));
    expect(webhooks.rows[0].payload).toEqual({ raw: 'not json at all' });
  });
});
