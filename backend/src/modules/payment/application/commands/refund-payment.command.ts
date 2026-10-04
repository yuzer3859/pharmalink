import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { Payment, PaymentProps } from '../../domain/entities/payment.entity';
import { Refund, RefundProps } from '../../domain/entities/refund.entity';
import { PaymentStatus, RefundDestination, RefundStatus, RefundType } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { paymentRefundedEvent } from '../../domain/events';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';
import {
  IRefundRepository,
  REFUND_REPOSITORY,
} from '../../domain/repositories/refund.repository';
import { PaymentStatusPolicy } from '../../domain/services/payment-status-policy';
import { RefundPolicy } from '../../domain/services/refund-policy';
import { Money } from '../../domain/value-objects/money.vo';
import {
  IPaymentProviderRegistry,
  PAYMENT_PROVIDER_REGISTRY,
  ProviderRefundResult,
} from '../ports/outbound/payment-provider.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import {
  RefundAccountingService,
  refundLedgerReference,
} from '../services/refund-accounting.service';
import { isUniqueConstraintViolation, runWithPaymentRetry } from '../support/payment-retry';
import { sanitizeProviderFailureReason } from '../support/sanitize-provider-failure';

/** The permission §9.3 requires for a manual/admin refund. */
export const FINANCE_REFUND_PERMISSION = 'finance:refund:any';

/**
 * Who is asking for the refund. The distinction exists because §9.3 attaches a permission and an
 * audit requirement to *manual* refunds specifically, and §3.2 F-RFD-03 calls it "audited approval
 * for manual refunds".
 *
 * `SYSTEM` is the saga-driven path — an order cancellation or a failed delivery compensating
 * itself. It has no human approver, so `approvedBy` stays `null`: recording a fabricated approver
 * would corrupt the very trail the field exists for. Nothing wires it yet (Module 06 integration is
 * a later task, and this task does not touch Module 06), but the two paths are distinguished here
 * so that wiring cannot later smuggle a saga refund through the human-approval path or the reverse.
 */
export enum RefundInitiator {
  MANUAL = 'MANUAL',
  SYSTEM = 'SYSTEM',
}

export interface RefundPaymentInput {
  paymentId: string;
  /** Omitted or `null` = refund everything still refundable (§9.3 — "amount omitted = full"). */
  amount?: number | null;
  /** Asserted by the caller and checked against the payment's; never used to convert. */
  currency?: string | null;
  reason?: string | null;
  /** §9.3's `destination`. Defaults to `ORIGINAL` (§7's own column default). */
  destination?: RefundDestination;
  /** BRULE-25. Required: every money operation carries one. */
  idempotencyKey: string;
  initiator: RefundInitiator;
  /** The acting human, for a `MANUAL` refund. Recorded as `approvedBy` and in the audit entry. */
  actorUserId?: string | null;
  /**
   * The acting principal's effective permissions, for a `MANUAL` refund. Checked here — not only
   * at the HTTP boundary — so an in-process caller cannot reach the manual path without
   * `finance:refund:any`.
   */
  actorPermissions?: readonly string[] | null;
}

export interface RefundPaymentResult {
  refundId: string;
  paymentId: string;
  amount: number;
  currency: string;
  type: RefundType;
  destination: RefundDestination;
  status: RefundStatus;
  /** The payment's status after the refund — see the class doc on the `PARTIALLY_REFUNDED` limit. */
  paymentStatus: PaymentStatus;
  providerRef: string | null;
  /** The `ledger_transactions.reference` of the refund posting. */
  ledgerReference: string | null;
  /** Still refundable on this payment after this refund. */
  remainingRefundable: number;
  /** When the refund was reserved, and when it actually completed (`null` while `PENDING`). */
  createdAt: Date;
  completedAt: Date | null;
  /** `true` when an already-committed refund was returned rather than a new one performed. */
  replay: boolean;
}

/**
 * `POST /payments/{id}/refunds` (§3.2, §9.3, §11.4, BRULE-24).
 *
 * ## Order of operations
 *
 *  1. Validate the request and check the manual-refund permission.
 *  2. **Reservation transaction** (`Serializable`): replay lookup, then read the already-refunded
 *     total, apply `RefundPolicy`, and insert the `PENDING` refund row — all in one transaction.
 *  3. **Provider refund — outside every database transaction** (`ORIGINAL` only).
 *  4. **Finalization transaction** (`Serializable`): the balanced REFUND posting, the refund's
 *     `COMPLETED` transition, the payment's status change, the audit entry and the
 *     `payment.refunded` event, together (ADR-010/ADR-013).
 *
 * ## Why the over-refund check must sit inside step 2's transaction
 *
 * BRULE-24 is `Σ refunds <= captured`, which no row-level constraint can express. Reading the sum
 * and then inserting the refund in *separate* transactions is the textbook write-skew: two
 * concurrent requests each read the same remainder, each find their amount acceptable, and together
 * over-refund. Doing both inside one `Serializable` transaction is what closes it — PostgreSQL's
 * SSI detects that each transaction wrote into the range the other summed, and aborts one with a
 * serialization failure. `runWithPaymentRetry` then re-runs the loser from the top, where it reads
 * the winner's row and correctly rejects with `REFUND_EXCEEDS_CAPTURED`. That retry is safe
 * precisely because step 2 contains no external side effect.
 *
 * ## Intent-first persistence, and the ambiguity rule
 *
 * The `PENDING` refund row is committed **before** the gateway is called, and its `id` is the
 * gateway's idempotency key. That ordering is what makes the external step recoverable: if the
 * process dies between the call and the local commit, the refund is still there in `PENDING`, and a
 * retry with the same idempotency key resumes it — reaching the gateway with the same `refundId`,
 * which the port requires to return the original refund rather than issue a second one.
 *
 * The three provider outcomes are handled very differently, and the third is the one that matters:
 *
 *  - `FAILED` — a positive decline. The refund becomes `FAILED`, no ledger posting is made, the
 *    payment is untouched, and the amount becomes refundable again (nothing left the platform).
 *  - `UNKNOWN`, or a thrown provider error — the refund **stays `PENDING`** and
 *    `DEPENDENCY_UNAVAILABLE` is raised. It must never become `FAILED`: a `FAILED` refund releases
 *    its amount back into the refundable pool, so mislabelling an ambiguous outcome as a failure
 *    would let the same money be refunded a second time — a double payout, the one error a refund
 *    flow must never make. A `PENDING` refund keeps the amount reserved until it is resolved.
 *  - `ALREADY_REFUNDED` — the gateway's normal answer to an idempotent retry. Treated as success.
 *
 * `WALLET` has no external step at all: the ledger credit *is* the refund, so it goes straight from
 * step 2 to step 4.
 *
 * ## The final payment status (ADR-018)
 *
 * §6 now carries `PARTIALLY_REFUNDED -> REFUNDED`, so a payment repaid in full over several
 * increments ends `REFUNDED` exactly like one repaid in a single request. The status is decided
 * from the **remainder**, never from a refund's own `FULL`/`PARTIAL` classification — see
 * {@link RefundPaymentCommand.resolvePaymentTransition}.
 *
 * The remainder that decides it counts only refunds that have actually **completed**, which is not
 * the same number as the one guarding over-refunds. An in-flight `PENDING` refund reserves its
 * amount against further requests (so it counts for eligibility) but has not returned any money
 * (so it must not count towards `REFUNDED`). Were the status decided on the reserving total, a
 * payment could become terminally `REFUNDED` while a `PENDING` refund was outstanding; if that
 * refund then failed, its amount would be refundable again with the payment stuck in a state
 * `RefundPolicy` refuses to refund from — money owed to a customer that could never be paid.
 */
@Injectable()
export class RefundPaymentCommand {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(REFUND_REPOSITORY) private readonly refunds: IRefundRepository,
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly providers: IPaymentProviderRegistry,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly accounting: RefundAccountingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const paymentId = requireText(input.paymentId, 'paymentId');
    const destination = input.destination ?? RefundDestination.ORIGINAL;

    // §9.3: manual/admin refunds require `finance:refund:any`. Checked before anything is read, so
    // an unauthorized caller cannot even confirm a payment exists.
    this.assertMayInitiate(input);

    // Step 1 — the reservation. Replay, eligibility, over-refund and the PENDING insert, atomically.
    const reserved = await this.reserve(paymentId, destination, input);
    if (reserved.replay) {
      return reserved.result;
    }

    const { payment, refund } = reserved;

    // Step 2 — the gateway call, outside every transaction. WALLET has no external step.
    const outcome =
      destination === RefundDestination.ORIGINAL
        ? await this.refundWithProvider(payment, refund, input)
        : null;

    // Step 3 — ledger + refund completion + payment transition + audit + event, atomically.
    return this.finalize(payment, refund, outcome, input);
  }

  // -----------------------------------------------------------------------------------------
  // Step 0 — authorization
  // -----------------------------------------------------------------------------------------

  /**
   * §3.2 F-RFD-03 / §9.3. A `MANUAL` refund needs a named actor holding `finance:refund:any`; a
   * `SYSTEM` refund needs neither, because it is not a human decision — but it must not carry an
   * actor either, or the audit trail would attribute an automated compensation to a person.
   *
   * There is deliberately **no customer self-service refund path**: the RBAC catalog defines no
   * customer refund permission, and §9.3 names only `finance:refund:any`. A customer therefore
   * cannot reach either branch — which is what "do not allow a customer to invoke an admin/manual
   * refund path" requires, enforced by the permission itself rather than by a role name.
   */
  private assertMayInitiate(input: RefundPaymentInput): void {
    if (input.initiator === RefundInitiator.SYSTEM) {
      return;
    }
    if (input.initiator !== RefundInitiator.MANUAL) {
      throw PaymentErrors.validation('Unknown refund initiator.', {
        field: 'initiator',
        value: input.initiator,
      });
    }

    const actorUserId = input.actorUserId ?? null;
    const permissions = input.actorPermissions ?? [];
    if (!actorUserId || !hasPermission(permissions, FINANCE_REFUND_PERMISSION)) {
      throw PaymentErrors.refundApprovalForbidden(actorUserId);
    }
  }

  // -----------------------------------------------------------------------------------------
  // Step 1 — reservation
  // -----------------------------------------------------------------------------------------

  private async reserve(
    paymentId: string,
    destination: RefundDestination,
    input: RefundPaymentInput,
  ): Promise<
    | { replay: true; result: RefundPaymentResult }
    | { replay: false; payment: PaymentProps; refund: RefundProps }
  > {
    try {
      return await runWithPaymentRetry(this.uow, async (tx) => {
        const existing = await this.refunds.findByIdempotencyKey(input.idempotencyKey, tx);
        if (existing) {
          return this.resolveExisting(existing, paymentId, destination, input, tx);
        }

        const payment = await this.payments.findById(paymentId, tx);
        if (!payment) {
          throw PaymentErrors.notFound('Payment not found.', { paymentId });
        }
        this.assertCurrencyMatches(payment, input.currency ?? null);

        // The read BRULE-24 is decided against, inside the same transaction as the insert below.
        const alreadyRefunded = Money.of(
          await this.refunds.totalRefundedForPayment(paymentId, tx),
          payment.currency,
        );

        const classification = RefundPolicy.classify({
          payment,
          alreadyRefunded,
          requestedAmount:
            input.amount === undefined || input.amount === null
              ? null
              : Money.of(input.amount, payment.currency),
          destination,
        });

        const entity = Refund.create(randomUUID(), {
          paymentId,
          amount: classification.amount,
          type: classification.type,
          destination,
          reason: input.reason ?? null,
          // Only a human approves; a saga has no approver (see `RefundInitiator`).
          approvedBy:
            input.initiator === RefundInitiator.MANUAL ? (input.actorUserId ?? null) : null,
          idempotencyKey: input.idempotencyKey,
        });
        const props = entity.toProps();

        const refund = await this.refunds.create(
          {
            id: props.id,
            paymentId: props.paymentId,
            amount: props.amount,
            reason: props.reason,
            type: props.type,
            destination: props.destination,
            status: props.status,
            approvedBy: props.approvedBy,
            idempotencyKey: props.idempotencyKey,
          },
          tx,
        );

        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? null,
            action: 'PAYMENT_REFUND_REQUESTED',
            resourceType: 'Refund',
            resourceId: refund.id,
            context: {
              ...this.auditContext(payment, refund),
              initiator: input.initiator,
              alreadyRefunded: classification.alreadyRefunded.amountMinor,
              remainingBefore: classification.remainingBefore.amountMinor,
            },
          },
          tx,
        );

        return { replay: false as const, payment, refund };
      });
    } catch (err) {
      // Two requests with the same idempotency key raced the unique index. The loser re-reads the
      // winner's row and continues from it — never inserting a second refund.
      if (isUniqueConstraintViolation(err)) {
        const winner = await this.refunds.findByIdempotencyKey(input.idempotencyKey);
        if (winner) {
          return this.resolveExisting(winner, paymentId, destination, input);
        }
      }
      throw err;
    }
  }

  /**
   * Interprets a refund already committed under this idempotency key.
   *
   * A key that was used for a materially different request is a conflict, never a silent
   * substitution (BRULE-25's replay safety only extends to the *same* request). Otherwise:
   * `COMPLETED`/`FAILED` are terminal and replay as-is, while a `PENDING` refund is **resumed** —
   * that is the recovery path for a process that died between the reservation and the gateway
   * call, and it is safe because the gateway is keyed on the same `refundId`.
   */
  private async resolveExisting(
    existing: RefundProps,
    paymentId: string,
    destination: RefundDestination,
    input: RefundPaymentInput,
    tx?: unknown,
  ): Promise<
    | { replay: true; result: RefundPaymentResult }
    | { replay: false; payment: PaymentProps; refund: RefundProps }
  > {
    const requestedAmount =
      input.amount === undefined || input.amount === null ? null : input.amount;
    if (
      existing.paymentId !== paymentId ||
      existing.destination !== destination ||
      (requestedAmount !== null && existing.amount !== requestedAmount)
    ) {
      throw PaymentErrors.idempotencyConflict({
        idempotencyKey: input.idempotencyKey,
        refundId: existing.id,
      });
    }

    const payment = await this.payments.findById(existing.paymentId, tx);
    if (!payment) {
      throw PaymentErrors.notFound('Payment not found.', { paymentId: existing.paymentId });
    }

    if (existing.status === RefundStatus.PENDING) {
      return { replay: false as const, payment, refund: existing };
    }

    return {
      replay: true as const,
      result: await this.buildResult(payment, existing, { replay: true }, tx),
    };
  }

  // -----------------------------------------------------------------------------------------
  // Step 2 — the gateway
  // -----------------------------------------------------------------------------------------

  private async refundWithProvider(
    payment: PaymentProps,
    refund: RefundProps,
    input: RefundPaymentInput,
  ): Promise<ProviderRefundResult> {
    // §9's rule for a refund's gateway: the one that took the money, resolved by the key recorded
    // on the payment — never re-resolved from `PaymentMethod`. Re-resolving by method would send
    // the refund to whichever gateway currently serves that method, which after a configuration
    // change is not the gateway holding the customer's money.
    const provider = this.providers.forKey(payment.provider);

    let result: ProviderRefundResult;
    try {
      result = await provider.refund({
        // Our committed `refunds.id` — the provider-side idempotency identity (see the port).
        refundId: refund.id,
        paymentId: payment.id,
        providerRef: payment.providerRef,
        orderId: payment.orderId,
        method: payment.method,
        amount: refund.amount,
        currency: payment.currency,
        capturedAmount: payment.amount,
        reason: refund.reason,
      });
    } catch (err) {
      // A thrown error is an UNKNOWN outcome, never a failure — see the class doc.
      throw PaymentErrors.providerUnavailable({
        paymentId: payment.id,
        refundId: refund.id,
        operation: 'refund',
        provider: payment.provider,
        cause: sanitizeProviderFailureReason(
          err instanceof Error ? err.message : String(err ?? ''),
        ),
      });
    }

    if (result.outcome === 'UNKNOWN') {
      if (result.providerRef && result.providerRef !== refund.providerRef) {
        // Persist any reference the gateway did give us — it is reconciliation's match key — while
        // leaving the refund PENDING. `updateState` is called with the refund's current status, so
        // this is a field write, not a transition.
        await this.refunds.updateState(refund.id, {
          status: refund.status,
          providerRef: result.providerRef,
        });
      }
      throw PaymentErrors.providerUnavailable({
        paymentId: payment.id,
        refundId: refund.id,
        operation: 'refund',
        provider: payment.provider,
        cause: 'The provider could not confirm whether the refund completed.',
      });
    }

    if (result.outcome === 'FAILED') {
      await this.recordFailure(payment, refund, result, input);
    }

    return result;
  }

  /**
   * A positive decline: mark the refund `FAILED` and audit it. No ledger posting, no payment
   * transition — nothing moved, so the amount returns to the refundable pool.
   */
  private async recordFailure(
    payment: PaymentProps,
    refund: RefundProps,
    result: ProviderRefundResult,
    input: RefundPaymentInput,
  ): Promise<never> {
    const reason = sanitizeProviderFailureReason(result.failureReason);
    const aggregate = Refund.rehydrate(refund);
    aggregate.fail(result.providerRef ?? refund.providerRef);
    const failed = aggregate.toProps();

    await runWithPaymentRetry(this.uow, async (tx) => {
      await this.refunds.updateState(
        refund.id,
        { status: failed.status, providerRef: failed.providerRef },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: input.actorUserId ?? null,
          action: 'PAYMENT_REFUND_FAILED',
          resourceType: 'Refund',
          resourceId: refund.id,
          context: {
            ...this.auditContext(payment, refund),
            initiator: input.initiator,
            outcome: 'FAILED',
            failureReason: reason,
            failureCode: result.failureCode ?? null,
          },
        },
        tx,
      );
    });

    // The design catalogues no `payment.refund_failed` event, and one is not invented here.
    throw PaymentErrors.refundFailed(reason, {
      paymentId: payment.id,
      refundId: refund.id,
      failureCode: result.failureCode ?? null,
    });
  }

  // -----------------------------------------------------------------------------------------
  // Step 3 — finalization
  // -----------------------------------------------------------------------------------------

  private async finalize(
    payment: PaymentProps,
    refund: RefundProps,
    outcome: ProviderRefundResult | null,
    input: RefundPaymentInput,
  ): Promise<RefundPaymentResult> {
    const providerRef = outcome?.providerRef ?? refund.providerRef;
    const reference = refundLedgerReference(refund.id);

    try {
      return await runWithPaymentRetry(this.uow, async (tx) => {
        // Re-read inside the transaction: a concurrent resume of the same PENDING refund may have
        // finalized it while the gateway call was in flight.
        const current = (await this.refunds.findById(refund.id, tx)) ?? refund;
        if (current.status === RefundStatus.COMPLETED) {
          const settled = (await this.payments.findById(payment.id, tx)) ?? payment;
          return this.buildResult(settled, current, { replay: true }, tx);
        }

        const fresh = (await this.payments.findById(payment.id, tx)) ?? payment;

        // §11.4's balanced posting. Its unique `REFUND-<refundId>` reference is the database-level
        // guarantee that one refund can never post twice.
        const posting = await this.accounting.post(fresh, current, tx);

        const aggregate = Refund.rehydrate(current);
        aggregate.complete(new Date(), providerRef);
        const completed = aggregate.toProps();
        const refundRow = await this.refunds.updateState(
          current.id,
          {
            status: completed.status,
            providerRef: completed.providerRef,
            completedAt: completed.completedAt,
          },
          tx,
        );

        // Two different remainders, for two different questions (see `IRefundRepository`).
        // `remaining` is what may still be *requested*, so it counts in-flight PENDING refunds and
        // is what the caller and the refunds query report. `settledRemaining` is what has actually
        // not yet gone back, counting COMPLETED refunds only, and it is what decides §6's status:
        // a payment must not become terminally `REFUNDED` while a PENDING refund could still fail
        // and make its amount refundable again.
        const remaining = fresh.amount - (await this.refunds.totalRefundedForPayment(payment.id, tx));
        const settledRemaining =
          fresh.amount - (await this.refunds.totalCompletedRefundedForPayment(payment.id, tx));
        const transition = this.resolvePaymentTransition(fresh, settledRemaining);

        const paymentRow = transition.target
          ? await this.payments.updateState(fresh.id, { status: transition.target }, tx)
          : fresh;

        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? null,
            action: 'PAYMENT_REFUNDED',
            resourceType: 'Refund',
            resourceId: refundRow.id,
            context: {
              ...this.auditContext(paymentRow, refundRow),
              initiator: input.initiator,
              approvedBy: refundRow.approvedBy,
              outcome: outcome?.outcome ?? 'WALLET_CREDIT',
              providerRef: refundRow.providerRef,
              ledgerReference: posting.reference,
              providerClawback: posting.split.providerClawback.amountMinor,
              feeClawback: posting.split.feeClawback.amountMinor,
              promotionClawback: posting.split.promotionClawback.amountMinor,
              remainingRefundable: remaining,
              paymentStatus: paymentRow.status,
              // Visible in the trail whenever §6's missing `PARTIALLY_REFUNDED -> REFUNDED` edge
              // stops the payment's status from following the money (see the class doc).
              paymentStatusAdvanced: transition.target !== null,
              paymentStatusLimitation: transition.limitation,
            },
          },
          tx,
        );

        // The catalogue's own `payment.refunded` event, with its own payload fields. No
        // `payment.refund_pending` / `payment.refund_failed` event is invented.
        await this.outbox.write(
          paymentRefundedEvent({ paymentId: payment.id, amount: refundRow.amount }),
          tx as OutboxCapableClient,
        );

        return this.buildResult(
          paymentRow,
          refundRow,
          { replay: false, ledgerReference: posting.reference, remaining },
          tx,
        );
      });
    } catch (err) {
      // A duplicate refund reference means a concurrent resume already posted this refund. The
      // unique index on `ledger_transactions.reference` is the backstop; the loser returns the
      // winner's committed result rather than posting a second time.
      if (isUniqueConstraintViolation(err)) {
        const winner = await this.refunds.findById(refund.id);
        const settled = await this.payments.findById(payment.id);
        if (winner && settled && winner.status === RefundStatus.COMPLETED) {
          return this.buildResult(settled, winner, { replay: true, ledgerReference: reference });
        }
      }
      throw err;
    }
  }

  /**
   * Which §6 transition, if any, this refund earns the payment.
   *
   * The decision is made **entirely from the remainder** — `REFUNDED` when nothing is left to
   * refund, `PARTIALLY_REFUNDED` otherwise. Deliberately *not* from `refund.type === FULL`: a
   * payment reaches zero through whatever sequence of partial refunds the customer was owed
   * (1000 → 100 → 300 → 600, or 1000 → 333 → 333 → 334), and only the running remainder knows
   * when that happened. `settledRemaining` is derived from the refunds table, never stored.
   *
   * A payment already in the target status needs no transition (that is not a state change), so
   * a partial refund of an already-`PARTIALLY_REFUNDED` payment is a no-op here. The final branch
   * is now a defect guard rather than a design gap: with ADR-018's edge in place, every reachable
   * (status, target) pair is either a no-op or a legal transition, so reaching it means the
   * remainder and the payment's status disagree. It refuses to transition rather than force one,
   * and the refund itself still stands — the ledger and `refunds` remain authoritative.
   */
  private resolvePaymentTransition(
    payment: PaymentProps,
    settledRemaining: number,
  ): { target: PaymentStatus | null; limitation: string | null } {
    const desired =
      settledRemaining <= 0 ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

    if (payment.status === desired) {
      return { target: null, limitation: null };
    }
    if (PaymentStatusPolicy.isLegalTransition(payment.status, desired)) {
      // Re-validated by the aggregate itself, so the policy is applied by the domain and not only
      // consulted here.
      const aggregate = Payment.rehydrate(payment);
      if (desired === PaymentStatus.REFUNDED) {
        aggregate.markRefunded();
      } else {
        aggregate.markPartiallyRefunded();
      }
      return { target: desired, limitation: null };
    }

    return {
      target: null,
      limitation: `No ${payment.status} -> ${desired} transition exists in the section 6 state machine, so the payment status was not advanced. The refund itself stands; the refunds table and the ledger remain authoritative for the refunded total.`,
    };
  }

  // -----------------------------------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------------------------------

  private async buildResult(
    payment: PaymentProps,
    refund: RefundProps,
    options: { replay: boolean; ledgerReference?: string; remaining?: number },
    tx?: unknown,
  ): Promise<RefundPaymentResult> {
    const remaining =
      options.remaining ??
      payment.amount - (await this.refunds.totalRefundedForPayment(payment.id, tx));

    return {
      refundId: refund.id,
      paymentId: payment.id,
      amount: refund.amount,
      currency: payment.currency,
      type: refund.type,
      destination: refund.destination,
      status: refund.status,
      paymentStatus: payment.status,
      providerRef: refund.providerRef,
      ledgerReference:
        options.ledgerReference ??
        (refund.status === RefundStatus.COMPLETED ? refundLedgerReference(refund.id) : null),
      remainingRefundable: Math.max(remaining, 0),
      createdAt: refund.createdAt,
      completedAt: refund.completedAt,
      replay: options.replay,
    };
  }

  /** A refund is settled in the payment's currency; a mismatch is never an implicit conversion. */
  private assertCurrencyMatches(payment: PaymentProps, currency: string | null): void {
    if (currency && currency.toUpperCase() !== payment.currency.toUpperCase()) {
      throw PaymentErrors.validation(
        `A refund must be in the payment's currency (${payment.currency}).`,
        { field: 'currency', expected: payment.currency, received: currency },
      );
    }
  }

  /**
   * §13's required refund audit fields: refund id, payment id, order id, amount, currency, type,
   * destination and reason. Never a token, a secret, a raw provider payload or card data — there
   * is no card data in this module to leak.
   */
  private auditContext(payment: PaymentProps, refund: RefundProps): Record<string, unknown> {
    return {
      refundId: refund.id,
      paymentId: payment.id,
      orderId: payment.orderId,
      amount: refund.amount,
      currency: payment.currency,
      type: refund.type,
      destination: refund.destination,
      reason: refund.reason,
      method: payment.method,
      provider: payment.provider,
    };
  }
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw PaymentErrors.validation(`${field} is required.`, { field });
  }
  return value.trim();
}
