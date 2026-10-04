import { AuditService } from '../../../../shared/audit/audit.service';
import { PaymentProps } from '../../domain/entities/payment.entity';
import { PaymentMethod, PaymentStatus } from '../../domain/enums';
import { IPaymentRepository } from '../../domain/repositories/payment.repository';
import {
  IWebhookRepository,
  ProviderWebhookSnapshot,
} from '../../domain/repositories/webhook.repository';
import {
  IProviderStatusPort,
  IProviderStatusRegistry,
} from '../ports/outbound/provider-status.port';
import { RECOVERABLE_STATUSES, ReconciliationService } from './reconciliation.service';

const NOW = new Date('2026-09-09T12:00:00.000Z');

function payment(overrides: Partial<PaymentProps> = {}): PaymentProps {
  const created = new Date('2026-09-09T10:00:00.000Z');
  return {
    id: 'payment-1',
    orderId: 'order-1',
    customerUserId: 'customer-1',
    method: PaymentMethod.TELEBIRR,
    status: PaymentStatus.INITIATED,
    amount: 10_000,
    currency: 'ETB',
    originalAmount: null,
    originalCurrency: null,
    fxRate: null,
    fxSource: null,
    provider: 'mock',
    providerRef: 'gw-ref-1',
    providerToken: null,
    idempotencyKey: 'pay-1',
    authorizedAt: null,
    capturedAt: null,
    failureReason: null,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  };
}

function harness(
  options: {
    stale?: PaymentProps[];
    unprocessed?: ProviderWebhookSnapshot[];
    statusPort?: IProviderStatusPort | null;
  } = {},
) {
  const stale = options.stale ?? [payment()];
  const findStale = jest.fn(async () => stale);
  const payments = {
    findById: jest.fn(async (id: string) => stale.find((p) => p.id === id) ?? null),
    findStale,
  } as unknown as IPaymentRepository;

  const webhooks = {
    findUnprocessed: jest.fn(async () => options.unprocessed ?? []),
  } as unknown as IWebhookRepository;

  const audits: Array<{ action: string; context?: Record<string, unknown> | null }> = [];
  const audit = {
    record: jest.fn(async (params: { action: string; context?: Record<string, unknown> | null }) => {
      audits.push(params);
      return { id: 'a', hash: 'h' };
    }),
  } as unknown as AuditService;

  const registry: IProviderStatusRegistry | null =
    options.statusPort === undefined
      ? null
      : { forProvider: () => options.statusPort ?? null };

  const service = new ReconciliationService(payments, webhooks, audit, registry);
  return { service, payments, webhooks, audits, findStale };
}

describe('ReconciliationService.sweep (§3.6 F-REC-01)', () => {
  it('scans the recoverable states, oldest-first, older than the threshold', async () => {
    const { service, findStale } = harness();

    await service.sweep({ now: NOW, olderThanMinutes: 15, limit: 50 });

    expect(findStale).toHaveBeenCalledWith({
      statuses: [...RECOVERABLE_STATUSES],
      olderThan: new Date(NOW.getTime() - 15 * 60_000),
      limit: 50,
    });
  });

  it('treats INITIATED and AUTHORIZED as the recoverable states', () => {
    // INITIATED holds async authorizations and crash-before-commit; AUTHORIZED holds Task 3's
    // ambiguous-capture window.
    expect([...RECOVERABLE_STATUSES]).toEqual([
      PaymentStatus.INITIATED,
      PaymentStatus.AUTHORIZED,
    ]);
  });

  it('reports each candidate with how long it has been stuck', async () => {
    const { service } = harness({ stale: [payment()] });

    const result = await service.sweep({ now: NOW });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      paymentId: 'payment-1',
      orderId: 'order-1',
      provider: 'mock',
      providerRef: 'gw-ref-1',
      status: PaymentStatus.INITIATED,
      stuckForMinutes: 120,
      providerLookupAvailable: false,
    });
  });

  it('reports candidates as unresolvable while no provider status adapter is bound', async () => {
    const { service } = harness({ stale: [payment(), payment({ id: 'payment-2' })] });

    const result = await service.sweep({ now: NOW });

    expect(result.unresolvableCount).toBe(2);
    expect(result.candidates.every((c) => !c.providerLookupAvailable)).toBe(true);
  });

  it('marks candidates resolvable once an adapter for their gateway exists', async () => {
    const port: IProviderStatusPort = {
      provider: 'mock',
      lookupPaymentStatus: jest.fn(async () => ({
        provider: 'mock',
        providerRef: 'gw-ref-1',
        status: PaymentStatus.AUTHORIZED,
      })),
    };
    const { service } = harness({ statusPort: port });

    const result = await service.sweep({ now: NOW });

    expect(result.candidates[0].providerLookupAvailable).toBe(true);
    expect(result.unresolvableCount).toBe(0);
  });

  it('includes callbacks that were recorded but never completed', async () => {
    const { service } = harness({
      unprocessed: [
        {
          id: 'webhook-1',
          provider: 'mock',
          eventId: 'evt-9',
          payload: { secretish: 'raw' },
          processedAt: null,
          createdAt: NOW,
        },
      ],
    });

    const result = await service.sweep({ now: NOW });

    expect(result.unprocessedWebhooks).toEqual([
      { id: 'webhook-1', provider: 'mock', eventId: 'evt-9', createdAt: NOW },
    ]);
    // The raw payload is not carried into the sweep result.
    expect(JSON.stringify(result.unprocessedWebhooks)).not.toContain('raw');
  });

  it('audits the sweep with counts and ids only', async () => {
    const { service, audits } = harness();

    await service.sweep({ now: NOW, olderThanMinutes: 30 });

    const entry = audits.find((a) => a.action === 'PAYMENT_RECONCILIATION_SWEEP');
    expect(entry?.context).toMatchObject({
      scannedAt: NOW.toISOString(),
      olderThanMinutes: 30,
      candidateCount: 1,
      unresolvableCount: 1,
      paymentIds: ['payment-1'],
    });
  });

  it('never transitions a payment or posts to the ledger', () => {
    // Its dependencies are payments, webhooks, audit and an optional provider-status registry —
    // no unit of work, no ledger, no provider payment port. Resolving a stuck payment means
    // deciding money moved, and unknown is not failure (§8). (`Function.length` counts 3: it
    // stops at the defaulted registry parameter.)
    expect(ReconciliationService.length).toBe(3);
    const source = String(ReconciliationService)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    expect(source).not.toMatch(/updateState|ledger|post\(/i);
  });

  it('returns an empty sweep cleanly when nothing is stuck', async () => {
    const { service } = harness({ stale: [] });

    const result = await service.sweep({ now: NOW });

    expect(result.candidates).toEqual([]);
    expect(result.unresolvableCount).toBe(0);
    expect(result.scannedAt).toBe(NOW);
  });
});

describe('ReconciliationService.compare', () => {
  it('reports no lookup available when the gateway offers none', async () => {
    const { service } = harness();

    await expect(service.compare('payment-1')).resolves.toEqual({
      paymentId: 'payment-1',
      localStatus: PaymentStatus.INITIATED,
      providerStatus: null,
      lookupAvailable: false,
      mismatch: false,
    });
  });

  it('flags a mismatch when the gateway disagrees with local state', async () => {
    const port: IProviderStatusPort = {
      provider: 'mock',
      lookupPaymentStatus: async () => ({
        provider: 'mock',
        providerRef: 'gw-ref-1',
        status: PaymentStatus.AUTHORIZED,
      }),
    };
    const { service } = harness({ statusPort: port });

    await expect(service.compare('payment-1')).resolves.toMatchObject({
      localStatus: PaymentStatus.INITIATED,
      providerStatus: PaymentStatus.AUTHORIZED,
      lookupAvailable: true,
      mismatch: true,
    });
  });

  it('does not call a gateway "I do not know" a discrepancy', async () => {
    const port: IProviderStatusPort = {
      provider: 'mock',
      lookupPaymentStatus: async () => ({
        provider: 'mock',
        providerRef: null,
        status: null,
      }),
    };
    const { service } = harness({ statusPort: port });

    await expect(service.compare('payment-1')).resolves.toMatchObject({
      providerStatus: null,
      mismatch: false,
    });
  });

  it('agrees when the gateway matches local state', async () => {
    const port: IProviderStatusPort = {
      provider: 'mock',
      lookupPaymentStatus: async () => ({
        provider: 'mock',
        providerRef: 'gw-ref-1',
        status: PaymentStatus.INITIATED,
      }),
    };
    const { service } = harness({ statusPort: port });

    await expect(service.compare('payment-1')).resolves.toMatchObject({ mismatch: false });
  });

  it('handles an unknown payment without throwing', async () => {
    const { service } = harness();
    await expect(service.compare('nope')).resolves.toMatchObject({ lookupAvailable: false });
  });
});
