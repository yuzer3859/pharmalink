import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { PaymentProps } from '../../domain/entities/payment.entity';
import { PaymentMethod, PaymentStatus } from '../../domain/enums';
import {
  IPaymentRepository,
  NewPaymentData,
  PaymentPage,
  PaymentStateUpdate,
  PaymentStatusTotals,
} from '../../domain/repositories/payment.repository';
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
import { VoidPaymentCommand } from './void-payment.command';

const PAYMENT_ID = 'payment-1';
const ORDER_ID = 'order-1';

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

  constructor(seed: PaymentProps[] = [], private readonly log: CallLog = []) {
    for (const row of seed) {
      this.rows.set(row.id, row);
    }
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
    throw new Error(`create must not be called during void (${data.id})`);
  }
  async updateState(id: string, update: PaymentStateUpdate): Promise<PaymentProps> {
    const row = this.rows.get(id) as PaymentProps;
    const next: PaymentProps = {
      ...row,
      status: update.status,
      providerRef: update.providerRef === undefined ? row.providerRef : update.providerRef,
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

class ScriptedProvider implements IPaymentProviderPort {
  readonly key = 'scripted';
  readonly voidRequests: ProviderPaymentOperationRequest[] = [];

  constructor(
    private readonly script: ProviderVoidResult | Error,
    private readonly log: CallLog = [],
  ) {}

  supports(): boolean {
    return true;
  }
  async authorize(): Promise<ProviderAuthorizationResult> {
    throw new Error('authorize must not be called during void');
  }
  async capture(): Promise<ProviderCaptureResult> {
    // Guards the design rule that a void must never be implemented as capture-then-refund.
    throw new Error('capture must not be called during void');
  }
  async refund(): Promise<ProviderRefundResult> {
    // The other half of that rule: releasing a hold is not a refund of collected money.
    throw new Error('refund must not be called during void');
  }
  async voidAuthorization(
    request: ProviderPaymentOperationRequest,
  ): Promise<ProviderVoidResult> {
    this.voidRequests.push(request);
    this.log.push('provider:void');
    if (this.script instanceof Error) {
      throw this.script;
    }
    return this.script;
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
  options: { payment?: Partial<PaymentProps>; provider?: ProviderVoidResult | Error } = {},
) {
  const log: CallLog = [];
  const payments = new InMemoryPaymentRepository([authorizedPayment(options.payment)], log);
  const provider = new ScriptedProvider(
    options.provider ?? { outcome: 'VOIDED', providerRef: 'gw-void-1' },
    log,
  );
  const audits: AuditEntry[] = [];
  const audit = {
    record: jest.fn(async (params: AuditEntry) => {
      audits.push(params);
      log.push(`audit:${params.action}`);
      return { id: 'audit-1', hash: 'hash' };
    }),
  } as unknown as AuditService;

  const command = new VoidPaymentCommand(
    payments,
    new SingleProviderRegistry(provider),
    new FakeUnitOfWork(log),
    audit,
  );
  return { command, payments, provider, audits, log };
}

/**
 * The command's source with comments stripped, so a claim about what the code *does* cannot be
 * satisfied or broken by prose describing what it deliberately does not do.
 */
function executableSource(target: { prototype: object }): string {
  return String(target)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
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

describe('VoidPaymentCommand — success (§6 AUTHORIZED -> VOIDED)', () => {
  it('voids an authorized payment', async () => {
    const { command, payments } = harness();

    const result = await command.execute({ paymentId: PAYMENT_ID });

    expect(result.status).toBe(PaymentStatus.VOIDED);
    expect(result.replay).toBe(false);
    const row = payments.rows.get(PAYMENT_ID) as PaymentProps;
    expect(row.status).toBe(PaymentStatus.VOIDED);
    // Nothing was ever collected, so no capture timestamp is invented.
    expect(row.capturedAt).toBeNull();
  });

  it('calls the provider void exactly once, with the authorization reference', async () => {
    const { command, provider } = harness();

    await command.execute({ paymentId: PAYMENT_ID });

    expect(provider.voidRequests).toHaveLength(1);
    expect(provider.voidRequests[0]).toMatchObject({
      paymentId: PAYMENT_ID,
      providerRef: 'gw-auth-1',
      amount: 10_000,
      currency: 'ETB',
    });
  });

  it('persists the void provider reference', async () => {
    const { command, payments } = harness({
      provider: { outcome: 'VOIDED', providerRef: 'gw-void-xyz' },
    });

    const result = await command.execute({ paymentId: PAYMENT_ID });

    expect(result.providerRef).toBe('gw-void-xyz');
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).providerRef).toBe('gw-void-xyz');
  });

  it('normalizes ALREADY_VOIDED from the gateway as success', async () => {
    const { command, payments } = harness({
      provider: { outcome: 'ALREADY_VOIDED', providerRef: 'gw-void-1' },
    });

    const result = await command.execute({ paymentId: PAYMENT_ID });

    expect(result.status).toBe(PaymentStatus.VOIDED);
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.VOIDED);
  });

  it('calls the provider void, never capture (a void is not a capture-then-refund)', async () => {
    const { command, log } = harness();

    await command.execute({ paymentId: PAYMENT_ID });

    expect(log).toContain('provider:void');
    // The provider double throws if `capture` is called; reaching here proves it was not.
    expect(log.filter((entry) => entry.startsWith('provider:'))).toEqual(['provider:void']);
  });
});

describe('VoidPaymentCommand — state guards', () => {
  it.each([
    PaymentStatus.CAPTURED,
    PaymentStatus.SETTLED,
    PaymentStatus.REFUNDED,
    PaymentStatus.PARTIALLY_REFUNDED,
  ])('refuses to void %s with PAYMENT_ALREADY_CAPTURED', async (status) => {
    const { command, provider, payments } = harness({ payment: { status } });

    const error = await expectApiError(
      command.execute({ paymentId: PAYMENT_ID }),
      ErrorCode.PAYMENT_ALREADY_CAPTURED,
    );
    expect(error.details).toMatchObject({ paymentId: PAYMENT_ID, status });
    expect(provider.voidRequests).toHaveLength(0);
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(status);
  });

  it.each([PaymentStatus.INITIATED, PaymentStatus.FAILED, PaymentStatus.EXPIRED])(
    'rejects void from %s via the existing state policy',
    async (status) => {
      const { command, provider } = harness({ payment: { status } });

      await expectApiError(
        command.execute({ paymentId: PAYMENT_ID }),
        ErrorCode.INVALID_PAYMENT_STATE_TRANSITION,
      );
      expect(provider.voidRequests).toHaveLength(0);
    },
  );

  it('rejects an unknown or blank payment id', async () => {
    const { command } = harness();
    await expectApiError(command.execute({ paymentId: 'nope' }), ErrorCode.NOT_FOUND);
    await expectApiError(command.execute({ paymentId: '   ' }), ErrorCode.VALIDATION_ERROR);
  });
});

describe('VoidPaymentCommand — idempotency (§8)', () => {
  it('an already-VOIDED payment replays without calling the provider again', async () => {
    const { command, provider } = harness({ payment: { status: PaymentStatus.VOIDED } });

    const result = await command.execute({ paymentId: PAYMENT_ID });

    expect(result.replay).toBe(true);
    expect(result.status).toBe(PaymentStatus.VOIDED);
    expect(provider.voidRequests).toHaveLength(0);
  });

  it('a sequential retry voids the authorization at most once', async () => {
    const { command, provider, audits } = harness();

    const first = await command.execute({ paymentId: PAYMENT_ID });
    const second = await command.execute({ paymentId: PAYMENT_ID });

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(provider.voidRequests).toHaveLength(1);
    // The replay writes no second audit entry either.
    expect(audits.filter((a) => a.action === 'PAYMENT_VOIDED')).toHaveLength(1);
  });
});

describe('VoidPaymentCommand — provider failure and ambiguity', () => {
  it('a refused void leaves the payment AUTHORIZED — the hold is still live', async () => {
    const { command, payments } = harness({
      provider: {
        outcome: 'FAILED',
        providerRef: 'gw-1',
        failureReason: 'Authorization already settled',
        failureCode: 'not_voidable',
      },
    });

    await expectApiError(
      command.execute({ paymentId: PAYMENT_ID }),
      ErrorCode.BUSINESS_RULE_VIOLATION,
    );
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.AUTHORIZED);
  });

  it('an UNKNOWN outcome does not transition the payment', async () => {
    const { command, payments } = harness({
      provider: { outcome: 'UNKNOWN', providerRef: null },
    });

    await expectApiError(
      command.execute({ paymentId: PAYMENT_ID }),
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.AUTHORIZED);
  });

  it('a thrown provider error is treated as unknown, not as a refusal', async () => {
    const { command, payments } = harness({ provider: new Error('ECONNRESET') });

    await expectApiError(
      command.execute({ paymentId: PAYMENT_ID }),
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );
    expect((payments.rows.get(PAYMENT_ID) as PaymentProps).status).toBe(PaymentStatus.AUTHORIZED);
  });

  it('sanitizes a provider failure reason', async () => {
    const { command, audits } = harness({
      provider: {
        outcome: 'FAILED',
        providerRef: 'gw-1',
        failureReason: 'Cannot void card 4111 1111 1111 1111',
      },
    });

    const error = await expectApiError(
      command.execute({ paymentId: PAYMENT_ID }),
      ErrorCode.BUSINESS_RULE_VIOLATION,
    );
    expect(error.message).not.toContain('4111');
    expect(JSON.stringify(audits)).not.toContain('4111');
  });
});

describe('VoidPaymentCommand — audit, events and ledger', () => {
  it('audits the void with the §13 fields', async () => {
    const { command, audits } = harness();

    await command.execute({
      paymentId: PAYMENT_ID,
      actorUserId: 'customer-1',
      reason: 'Customer cancelled',
    });

    const entry = audits.find((a) => a.action === 'PAYMENT_VOIDED');
    expect(entry).toBeDefined();
    expect(entry?.actorUserId).toBe('customer-1');
    expect(entry?.resourceType).toBe('Payment');
    expect(entry?.resourceId).toBe(PAYMENT_ID);
    expect(entry?.context).toMatchObject({
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      provider: 'scripted',
      providerRef: 'gw-void-1',
      outcome: 'VOIDED',
      reason: 'Customer cancelled',
    });
  });

  it('writes the transition and its audit entry in one transaction', async () => {
    const { command, log } = harness();

    await command.execute({ paymentId: PAYMENT_ID });

    const commit = log.indexOf('tx:commit');
    expect(log.indexOf('payment:update:VOIDED')).toBeLessThan(commit);
    expect(log.indexOf('audit:PAYMENT_VOIDED')).toBeLessThan(commit);
    // And the provider call happened before that transaction opened.
    expect(log.indexOf('provider:void')).toBeLessThan(log.indexOf('payment:update:VOIDED'));
  });

  it('emits no outbox event — the design catalogues no PaymentVoided', () => {
    // The command takes no OutboxService at all, so an event cannot be emitted by accident:
    // (payments, provider, uow, audit) and nothing else.
    expect(VoidPaymentCommand.length).toBe(4);
    expect(executableSource(VoidPaymentCommand)).not.toMatch(/outbox|payment\.voided/i);
  });

  it('makes no ledger posting — a released hold moved no money', () => {
    expect(executableSource(VoidPaymentCommand)).not.toMatch(/ledger/i);
  });
});
