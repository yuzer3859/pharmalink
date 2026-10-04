import { Inject, Injectable, Optional } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { PaymentProps } from '../../domain/entities/payment.entity';
import { PaymentStatus } from '../../domain/enums';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';
import {
  IWebhookRepository,
  WEBHOOK_REPOSITORY,
} from '../../domain/repositories/webhook.repository';
import {
  IProviderStatusRegistry,
  PROVIDER_STATUS_REGISTRY,
} from '../ports/outbound/provider-status.port';

/**
 * States a payment can legitimately be stuck in, and from which it is still recoverable.
 *
 * `INITIATED` is the whole point: it is where an async authorization awaiting the customer, a
 * provider timeout, an unknown outcome and a crash-before-commit all come to rest.
 * `AUTHORIZED` is included because Task 3's ambiguous-capture window leaves a payment there while
 * the gateway may in fact hold a capture.
 */
export const RECOVERABLE_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.INITIATED,
  PaymentStatus.AUTHORIZED,
];

/** Why a payment is a candidate, and what is known about resolving it. */
export interface ReconciliationCandidate {
  paymentId: string;
  orderId: string;
  provider: string | null;
  providerRef: string | null;
  status: PaymentStatus;
  amount: number;
  currency: string;
  /** How long it has been sitting in this state, in whole minutes. */
  stuckForMinutes: number;
  /**
   * Whether a `IProviderStatusPort` is bound for this payment's gateway. `false` means the
   * candidate is real but cannot be resolved automatically yet — it needs a human, or the
   * provider-adapter task.
   */
  providerLookupAvailable: boolean;
}

export interface ReconciliationSweepResult {
  scannedAt: Date;
  /** Payments in a recoverable state older than the threshold. */
  candidates: ReconciliationCandidate[];
  /** Callbacks recorded but never completed — the other half of the recovery picture. */
  unprocessedWebhooks: Array<{ id: string; provider: string; eventId: string; createdAt: Date }>;
  /** Candidates whose gateway exposes no status lookup, so nothing automatic can resolve them. */
  unresolvableCount: number;
}

export interface ReconciliationSweepOptions {
  /** Ignore payments younger than this; they are probably just in flight. Default 15 minutes. */
  olderThanMinutes?: number;
  /** Bound on rows examined per sweep. Default 100. */
  limit?: number;
  statuses?: PaymentStatus[];
  /** Injectable for deterministic tests. */
  now?: Date;
}

const DEFAULT_STALE_MINUTES = 15;
const DEFAULT_LIMIT = 100;

/**
 * The reconciliation foundation required by §3.6 F-REC-01 — the *discovery and reporting* half.
 *
 * It answers one question: **which payments are stuck, and can anything resolve them?** It finds
 * payments left in a recoverable state past a threshold, pairs them with the callbacks that were
 * received but never completed, and reports whether the gateway in question even offers a status
 * lookup to resolve them with.
 *
 * ## What this deliberately does not do
 *
 * It does not transition payments, post to the ledger, or call a gateway. Resolving a stuck
 * payment means deciding that money did or did not move, and this task's own rule is that
 * unknown is not failure — so nothing here guesses. The sweep produces candidates and records
 * that it looked; acting on them belongs to the scheduled reconciliation task, once a real
 * `IProviderStatusPort` adapter exists to give it a confident answer.
 *
 * It is also not scheduled. No `@Cron` is registered: a sweeper that runs in production before
 * anything can act on its output is noise. `ReconciliationScheduler` (§10) is the later task's.
 *
 * `PROVIDER_STATUS_REGISTRY` is optional precisely so this works today, when no adapter is bound:
 * every candidate is reported with `providerLookupAvailable: false` rather than the service being
 * unconstructable.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(WEBHOOK_REPOSITORY) private readonly webhooks: IWebhookRepository,
    private readonly audit: AuditService,
    @Optional()
    @Inject(PROVIDER_STATUS_REGISTRY)
    private readonly providerStatus: IProviderStatusRegistry | null = null,
  ) {}

  /**
   * Finds everything currently in need of reconciliation and records that the sweep happened
   * (§13 — reconciliation runs and discrepancies are auditable).
   */
  async sweep(options: ReconciliationSweepOptions = {}): Promise<ReconciliationSweepResult> {
    const now = options.now ?? new Date();
    const staleMinutes = options.olderThanMinutes ?? DEFAULT_STALE_MINUTES;
    const limit = options.limit ?? DEFAULT_LIMIT;
    const olderThan = new Date(now.getTime() - staleMinutes * 60_000);

    const stale = await this.payments.findStale({
      statuses: options.statuses ?? [...RECOVERABLE_STATUSES],
      olderThan,
      limit,
    });

    const candidates = stale.map((payment) => this.toCandidate(payment, now));
    const unprocessed = await this.webhooks.findUnprocessed(limit);
    const unresolvableCount = candidates.filter((c) => !c.providerLookupAvailable).length;

    await this.audit.record({
      actorUserId: null,
      action: 'PAYMENT_RECONCILIATION_SWEEP',
      resourceType: 'Payment',
      resourceId: null,
      context: {
        scannedAt: now.toISOString(),
        olderThanMinutes: staleMinutes,
        candidateCount: candidates.length,
        unprocessedWebhookCount: unprocessed.length,
        unresolvableCount,
        // Ids only — never amounts-per-payment dumps, tokens or provider payloads.
        paymentIds: candidates.map((c) => c.paymentId),
      },
    });

    return {
      scannedAt: now,
      candidates,
      unprocessedWebhooks: unprocessed.map((row) => ({
        id: row.id,
        provider: row.provider,
        eventId: row.eventId,
        createdAt: row.createdAt,
      })),
      unresolvableCount,
    };
  }

  /**
   * Compares one payment against what its gateway says, when a status port is bound.
   *
   * Returns the comparison only — it never applies it. A `mismatch` here is a finding for a human
   * or for the later scheduled task, not a licence for this service to move money.
   */
  async compare(paymentId: string): Promise<{
    paymentId: string;
    localStatus: PaymentStatus;
    providerStatus: PaymentStatus | null;
    lookupAvailable: boolean;
    mismatch: boolean;
  }> {
    const payment = await this.payments.findById(paymentId);
    if (!payment) {
      return {
        paymentId,
        localStatus: PaymentStatus.INITIATED,
        providerStatus: null,
        lookupAvailable: false,
        mismatch: false,
      };
    }

    const port = payment.provider
      ? this.providerStatus?.forProvider(payment.provider) ?? null
      : null;
    if (!port) {
      return {
        paymentId,
        localStatus: payment.status,
        providerStatus: null,
        lookupAvailable: false,
        mismatch: false,
      };
    }

    const remote = await port.lookupPaymentStatus({
      paymentId: payment.id,
      providerRef: payment.providerRef,
    });
    return {
      paymentId,
      localStatus: payment.status,
      providerStatus: remote.status,
      lookupAvailable: true,
      // A `null` remote status is "the gateway does not know", which is not a discrepancy.
      mismatch: remote.status !== null && remote.status !== payment.status,
    };
  }

  private toCandidate(payment: PaymentProps, now: Date): ReconciliationCandidate {
    const reference = payment.updatedAt ?? payment.createdAt;
    return {
      paymentId: payment.id,
      orderId: payment.orderId,
      provider: payment.provider,
      providerRef: payment.providerRef,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      stuckForMinutes: Math.max(
        0,
        Math.floor((now.getTime() - reference.getTime()) / 60_000),
      ),
      providerLookupAvailable: Boolean(
        payment.provider && this.providerStatus?.forProvider(payment.provider),
      ),
    };
  }
}
