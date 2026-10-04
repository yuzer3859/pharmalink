import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { Payment, PaymentProps } from '../../domain/entities/payment.entity';
import { PaymentMethod, PaymentStatus } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { paymentAuthorizedEvent, paymentFailedEvent } from '../../domain/events';
import {
  IPaymentRepository,
  NewPaymentData,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';
import { Currency } from '../../domain/value-objects/currency.vo';
import { IdempotencyKey } from '../../domain/value-objects/idempotency-key.vo';
import { Money } from '../../domain/value-objects/money.vo';
import { IOrderPort, ORDER_PORT, PayableOrderView } from '../ports/outbound/order.port';
import {
  IPaymentProviderPort,
  IPaymentProviderRegistry,
  PAYMENT_PROVIDER_REGISTRY,
  ProviderAuthorizationResult,
} from '../ports/outbound/payment-provider.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { isUniqueConstraintViolation, runWithPaymentRetry } from '../support/payment-retry';
import { sanitizeProviderFailureReason } from '../support/sanitize-provider-failure';

/**
 * Business input for `POST /payments/authorize` (§9.1), transport-independent: no DTO, no header,
 * no request object. The HTTP task maps its DTO onto this; Module 06's checkout saga will call it
 * through the exported `IPaymentAuthorizationPort`.
 */
export interface AuthorizePaymentInput {
  /** Resolved from the authenticated principal by the caller — never taken from a request body. */
  customerUserId: string;
  orderId: string;
  method: PaymentMethod;
  /**
   * The amount the client *believes* it is paying, in minor units (§9.1's request shape).
   * Optional, and **never authoritative**: when present it is checked against the order's own
   * `grandTotal` and a mismatch is rejected. What is actually authorized always comes from the
   * order. See {@link AuthorizePaymentCommand} step 4.
   */
  amount?: number;
  currency?: string;
  /** Opaque gateway token (§9.1's `token?`). Never card data (BRULE-26). */
  providerToken?: string | null;
  /** Where the gateway returns the customer after a hosted/redirect flow (§9.1). */
  returnUrl?: string | null;
  /** REQUIRED replay key (BRULE-25, §4). */
  idempotencyKey: string;
}

/** §9.1's `{ paymentId, status, providerRedirect? }`, plus what a caller needs to act on it. */
export interface AuthorizePaymentResult {
  paymentId: string;
  /** `AUTHORIZED` (funds held) or `INITIATED` (customer action still required). */
  status: PaymentStatus;
  /** Present only for an async/redirect flow (§9.1). */
  providerRedirect: string | null;
  amount: number;
  currency: string;
  provider: string | null;
  providerRef: string | null;
  /** `true` when an already-committed payment was returned instead of a new one being created. */
  replay: boolean;
}

/** Order statuses from which a payment may be authorized (BRULE-17 — authorization precedes
 * order confirmation, so the order is still awaiting payment). */
const PAYABLE_ORDER_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'PENDING_PAYMENT']);

/** A payment in one of these states is live money for its order; a second one must not be opened. */
const ACTIVE_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.INITIATED,
  PaymentStatus.AUTHORIZED,
  PaymentStatus.CAPTURED,
  PaymentStatus.SETTLED,
]);

/**
 * `POST /payments/authorize` (§9.1, §11.1, BR-PAY-01/02/03/04, BRULE-17, BRULE-25).
 *
 * ## Order of operations, and why
 *
 *  1. **Validate the request shape** — `IdempotencyKey`, `Currency` and `PaymentMethod` are
 *     parsed through their value objects first, so a malformed request never reaches the order
 *     lookup, let alone the gateway.
 *  2. **Idempotency replay check** (BRULE-25) — `IPaymentRepository.findByIdempotencyKey()`
 *     before any other work. A sequential retry therefore does **no** provider call at all and
 *     returns the original payment. A key reused for a materially different request (different
 *     order, customer, method or amount) is a deterministic `IDEMPOTENCY_CONFLICT`, never a
 *     silently-returned mismatched payment.
 *  3. **Order + ownership + eligibility** — the order is read through `IOrderPort`; an order that
 *     does not exist *or belongs to someone else* resolves to the same `ORDER_NOT_FOUND`, so this
 *     endpoint cannot be used to probe other customers' orders. Its status must be payable, and
 *     it must not already have an active payment.
 *  4. **Authoritative amount** — the amount and currency authorized are the order's own
 *     `grandTotal`/`currency`, which Module 06 computed inside its checkout transaction from
 *     fresh Catalog prices. A client-supplied `amount`/`currency` is only ever *checked* against
 *     them; it is never used. Module 07 does not re-derive order pricing (that would create a
 *     second source of truth for what the customer owes).
 *  5. **Persist `INITIATED` — committed, before the gateway is called.** See below.
 *  6. **Provider authorization — outside every database transaction.** See below.
 *  7. **Persist the outcome** in a second short `Serializable` transaction: the validated §6
 *     transition, its audit entry and its outbox event, together (ADR-010/ADR-013).
 *
 * ## Why the intent record is committed before the provider call
 *
 * This is the crux of making an *external* side effect idempotent, and a unique database
 * constraint alone cannot do it. If the gateway were called first, a crash between "provider
 * authorized" and "row committed" would leave money held at the provider that this system has no
 * record of, and no key to reconcile it by — an orphaned authorization, invisible and
 * unrecoverable.
 *
 * So the `Payment` row is committed as `INITIATED` **first**, and its `id` is passed to the
 * gateway as the provider-side idempotency key (`ProviderAuthorizationRequest.paymentId`). That
 * gives every subsequent failure window a durable handle:
 *
 *  - *Crash after commit, before the provider call* — an `INITIATED` payment with no
 *    `providerRef`. Retrying with the same idempotency key re-enters at step 2, finds it, and
 *    (once the webhook/reconciliation task exists) resolves it against the provider.
 *  - *Crash after the provider call, before step 7 commits* — the payment is still `INITIATED`,
 *    and the gateway holds an authorization keyed by that same `paymentId`. Nothing is lost, and
 *    nothing is double-charged: re-driving the authorization is safe precisely because the
 *    gateway keys on `paymentId`, not on a fresh random reference per attempt.
 *  - *Provider call throws (network/timeout)* — the outcome is **unknown**, not failed. The
 *    payment is deliberately left `INITIATED` and `DEPENDENCY_UNAVAILABLE` is returned. Marking
 *    it `FAILED` here could permanently hide a real authorization.
 *
 * **Known, documented gap:** closing those windows automatically requires the provider webhook
 * and the reconciliation sweeper (§11.2, §3.6 F-REC-01), which are explicitly out of scope for
 * this task. Until they exist, a payment can legitimately sit in `INITIATED` with an
 * authorization held at the gateway, and nothing in this module will move it on its own. That is
 * a *recoverable* state by construction — the row, its `paymentId` and its `providerRef` are all
 * persisted — but it is not yet *automatically* recovered. The reconciliation of that state is
 * the next task's job, and this command is built so that it has everything it needs.
 *
 * ## Why the provider call is outside the transaction
 *
 * A gateway call is slow, retryable and failure-prone. Holding a `Serializable` transaction open
 * across it would pin a database connection for the round trip, widen every conflict window, and
 * — worst — mean a serialization retry (`runWithPaymentRetry`) re-issued the charge. Both
 * transactions here are short, local and side-effect-free, so retrying either is safe. This is
 * the same discipline Module 06 already applies to its cross-module port calls (ADR-014).
 *
 * ## Ledger
 *
 * **No ledger posting is made at authorization**, deliberately. §11.1's "(hold posting if
 * applicable)" has no applicable posting in this design: §7's chart of accounts contains no
 * authorization-hold account, and §5.3/§11.3 place the first real movement — `DEBIT
 * Gateway-Clearing / CREDIT Provider-Payable + Platform-Revenue` — at **capture**, when money is
 * actually collected. An authorization is a hold at the provider, not a movement of platform
 * money. Posting provider payable here would accrue a liability for an order that may never be
 * fulfilled. `LedgerService` is therefore not a dependency of this command at all; the capture
 * task adds it.
 */
@Injectable()
export class AuthorizePaymentCommand {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(ORDER_PORT) private readonly orders: IOrderPort,
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly providers: IPaymentProviderRegistry,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: AuthorizePaymentInput): Promise<AuthorizePaymentResult> {
    // Step 1 — validate the request shape through the domain's own value objects.
    const idempotencyKey = IdempotencyKey.of(input.idempotencyKey);
    if (!Object.values(PaymentMethod).includes(input.method)) {
      throw PaymentErrors.validation('Unknown payment method.', {
        field: 'method',
        value: input.method,
      });
    }
    if (input.currency !== undefined) {
      // Throws VALIDATION_ERROR for a malformed code before anything else happens.
      Currency.of(input.currency);
    }
    if (!input.customerUserId || input.customerUserId.trim().length === 0) {
      throw PaymentErrors.validation('customerUserId is required.', { field: 'customerUserId' });
    }

    // Step 2 — idempotency replay, before any order read and before any provider call.
    const existing = await this.payments.findByIdempotencyKey(idempotencyKey.value);
    if (existing) {
      this.assertSameLogicalRequest(existing, input);
      return this.toResult(existing, null, true);
    }

    // Step 3 — order, ownership, eligibility.
    const order = await this.loadPayableOrder(input.orderId, input.customerUserId);

    // Step 4 — the authoritative amount is the order's, never the caller's.
    const amount = this.resolveAuthoritativeAmount(order, input);

    // Gateway selection (§3.1 F-PAY-01, §10's Strategy). The registry resolves the available
    // provider for this method; this command knows no provider class and branches on no provider
    // key. Resolved before the row is written, so an unroutable method never leaves an abandoned
    // INITIATED payment behind.
    const provider = this.providers.forMethod(input.method);

    // Step 5 — commit the INITIATED intent record BEFORE calling the gateway (see class doc).
    const initiated = await this.persistInitiated(input, order, amount, idempotencyKey, provider);
    if (initiated.replay) {
      // Lost an idempotency-key race against a concurrent identical request. The winner already
      // owns this logical payment; this attempt must NOT call the provider (that would be the
      // second charge the whole design exists to prevent).
      return this.toResult(initiated.payment, null, true);
    }

    // Step 6 — the gateway call, outside every transaction.
    const outcome = await this.authorizeWithProvider(initiated.payment, input, provider);

    // Step 7 — persist the §6 transition + audit + outbox, atomically.
    return this.persistOutcome(initiated.payment, outcome, input);
  }

  /**
   * A replay is only a replay if it is the *same* logical request. Comparing just the customer
   * (as Module 06's checkout does) is not enough here: reusing one key for a different order,
   * method or amount would otherwise return a payment that authorizes something the caller did
   * not ask for.
   */
  private assertSameLogicalRequest(existing: PaymentProps, input: AuthorizePaymentInput): void {
    const mismatch =
      existing.customerUserId !== input.customerUserId ||
      existing.orderId !== input.orderId ||
      existing.method !== input.method ||
      (input.amount !== undefined && existing.amount !== input.amount) ||
      (input.currency !== undefined && existing.currency !== input.currency);

    if (mismatch) {
      throw PaymentErrors.idempotencyConflict({ paymentId: existing.id });
    }
  }

  private async loadPayableOrder(
    orderId: string,
    customerUserId: string,
  ): Promise<PayableOrderView> {
    const order = await this.orders.getOrder(orderId);
    // An order owned by someone else is reported exactly like a missing one — no existence
    // leakage across customers (the discipline `GetOrderQuery` already applies in Module 06).
    if (!order || order.customerUserId !== customerUserId) {
      throw PaymentErrors.orderNotFound({ orderId });
    }
    if (!PAYABLE_ORDER_STATUSES.has(order.status)) {
      throw PaymentErrors.orderNotPayable(order.status);
    }

    const active = (await this.payments.findByOrderId(orderId)).find((payment) =>
      ACTIVE_PAYMENT_STATUSES.has(payment.status),
    );
    if (active) {
      throw PaymentErrors.orderAlreadyHasActivePayment(active.id, active.status);
    }
    return order;
  }

  /**
   * §2 BR-PAY-03: the amount comes from the order. A client-supplied amount is treated as an
   * assertion to verify, not an instruction to follow — if it disagrees with the order, the
   * client is working from a stale total and must re-read it rather than have either value
   * silently win.
   */
  private resolveAuthoritativeAmount(
    order: PayableOrderView,
    input: AuthorizePaymentInput,
  ): Money {
    if (input.amount !== undefined && input.amount !== order.grandTotal) {
      throw PaymentErrors.validation(
        'The requested amount does not match the order total. Re-read the order and retry.',
        { field: 'amount', requested: input.amount, orderTotal: order.grandTotal },
      );
    }
    if (input.currency !== undefined && input.currency !== order.currency) {
      throw PaymentErrors.validation(
        'The requested currency does not match the order currency.',
        { field: 'currency', requested: input.currency, orderCurrency: order.currency },
      );
    }
    // `Money.of` + `Payment.initiate` enforce integer minor units, positivity, ETB and the
    // storable range — an order with a zero or malformed total is rejected here, not charged.
    return Money.of(order.grandTotal, order.currency);
  }

  /**
   * Writes the `INITIATED` payment + its audit entry in one `Serializable` transaction and
   * commits it, so the gateway call that follows has a durable, reconcilable handle.
   *
   * No outbox event is written here: the design's event catalogue (§10,
   * `00-domain-event-catalog.md`) defines `PaymentAuthorized`/`PaymentCaptured`/`PaymentFailed`/
   * `PaymentRefunded` and no `PaymentInitiated`. Initiation is distinguished in the **audit
   * log**, which is where §13 puts it ("payment authorized/captured/failed/voided"), rather than
   * by inventing an uncatalogued event with no consumer.
   *
   * A `P2002` on `payments.idempotencyKey` means a concurrent identical request won the race; the
   * winner is re-read and returned as a replay, mirroring `CheckoutCommand`'s handling of the
   * same race on `orders.idempotencyKey`.
   */
  private async persistInitiated(
    input: AuthorizePaymentInput,
    order: PayableOrderView,
    amount: Money,
    idempotencyKey: IdempotencyKey,
    provider: IPaymentProviderPort,
  ): Promise<{ payment: PaymentProps; replay: boolean }> {
    const payment = Payment.initiate(randomUUID(), {
      orderId: order.id,
      customerUserId: input.customerUserId,
      method: input.method,
      amount,
      idempotencyKey,
      provider: provider.key,
      providerToken: input.providerToken ?? null,
    });
    const props = payment.toProps();

    try {
      const created = await runWithPaymentRetry(this.uow, async (tx) => {
        const row = await this.payments.create(this.toNewPaymentData(props), tx);
        await this.audit.record(
          {
            actorUserId: input.customerUserId,
            action: 'PAYMENT_INITIATED',
            resourceType: 'Payment',
            resourceId: row.id,
            context: this.auditContext(row),
          },
          tx,
        );
        return row;
      });
      return { payment: created, replay: false };
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        const winner = await this.payments.findByIdempotencyKey(idempotencyKey.value);
        if (winner) {
          this.assertSameLogicalRequest(winner, input);
          return { payment: winner, replay: true };
        }
      }
      throw err;
    }
  }

  /**
   * The external call. Outside every transaction (see class doc). A thrown error means the
   * outcome is *unknown* — the payment stays `INITIATED` and `DEPENDENCY_UNAVAILABLE` is raised,
   * never `FAILED`, because a network error is not a decline and treating it as one could bury a
   * real authorization.
   */
  private async authorizeWithProvider(
    payment: PaymentProps,
    input: AuthorizePaymentInput,
    provider: IPaymentProviderPort,
  ): Promise<ProviderAuthorizationResult> {
    try {
      return await provider.authorize({
        paymentId: payment.id,
        idempotencyKey: payment.idempotencyKey,
        orderId: payment.orderId,
        customerUserId: payment.customerUserId,
        method: payment.method,
        amount: payment.amount,
        currency: payment.currency,
        providerToken: input.providerToken ?? null,
        returnUrl: input.returnUrl ?? null,
      });
    } catch (err) {
      throw PaymentErrors.providerUnavailable({
        paymentId: payment.id,
        provider: payment.provider,
        // The provider's own error object is never propagated — only a sanitized summary, so a
        // gateway exception carrying a payload cannot leak into a client response or a log.
        cause: sanitizeProviderFailureReason(
          err instanceof Error ? err.message : String(err ?? ''),
        ),
      });
    }
  }

  /**
   * Applies the §6 transition the provider's outcome implies, together with its audit entry and
   * its outbox event, in one `Serializable` transaction (ADR-010/ADR-013).
   *
   *  - `AUTHORIZED` -> `INITIATED -> AUTHORIZED`, audit + `payment.authorized`.
   *  - `PENDING`    -> stays `INITIATED`; the redirect is returned. No `payment.authorized` is
   *    emitted, because nothing is authorized yet — the webhook task emits it on confirmation.
   *    The provider reference (when the gateway already issued one) is persisted so that webhook
   *    can be matched to this payment.
   *  - `FAILED`     -> `INITIATED -> FAILED`, audit + `payment.failed`, then `PAYMENT_AUTH_FAILED`
   *    is thrown **after** the transition is committed, so the failure is durably recorded rather
   *    than existing only in the caller's error.
   */
  private async persistOutcome(
    payment: PaymentProps,
    result: ProviderAuthorizationResult,
    input: AuthorizePaymentInput,
  ): Promise<AuthorizePaymentResult> {
    const aggregate = Payment.rehydrate(payment);
    const now = new Date();
    const providerRef = result.providerRef ?? null;

    if (result.outcome === 'FAILED') {
      const reason = sanitizeProviderFailureReason(result.failureReason);
      aggregate.fail(reason, now);
      const props = aggregate.toProps();

      await runWithPaymentRetry(this.uow, async (tx) => {
        await this.payments.updateState(
          payment.id,
          { status: props.status, failureReason: props.failureReason, providerRef },
          tx,
        );
        await this.audit.record(
          {
            actorUserId: input.customerUserId,
            action: 'PAYMENT_AUTH_FAILED',
            resourceType: 'Payment',
            resourceId: payment.id,
            context: {
              ...this.auditContext(payment),
              outcome: 'FAILED',
              // Sanitized reason/code only — never a provider payload (§13, BRULE-26).
              failureReason: reason,
              failureCode: result.failureCode ?? null,
            },
          },
          tx,
        );
        await this.outbox.write(
          paymentFailedEvent({
            paymentId: payment.id,
            orderId: payment.orderId,
            reason,
          }),
          tx as OutboxCapableClient,
        );
      });

      throw PaymentErrors.paymentAuthFailed(reason, {
        paymentId: payment.id,
        orderId: payment.orderId,
        failureCode: result.failureCode ?? null,
      });
    }

    if (result.outcome === 'AUTHORIZED') {
      aggregate.authorize(now, providerRef);
      const props = aggregate.toProps();

      const updated = await runWithPaymentRetry(this.uow, async (tx) => {
        const row = await this.payments.updateState(
          payment.id,
          { status: props.status, authorizedAt: props.authorizedAt, providerRef },
          tx,
        );
        await this.audit.record(
          {
            actorUserId: input.customerUserId,
            action: 'PAYMENT_AUTHORIZED',
            resourceType: 'Payment',
            resourceId: payment.id,
            context: { ...this.auditContext(row), outcome: 'AUTHORIZED', providerRef },
          },
          tx,
        );
        await this.outbox.write(
          paymentAuthorizedEvent({ paymentId: payment.id, orderId: payment.orderId }),
          tx as OutboxCapableClient,
        );
        return row;
      });

      return this.toResult(updated, null, false);
    }

    // PENDING — the customer still has to act. The payment stays INITIATED (§6: an async payment
    // is never marked AUTHORIZED without provider confirmation).
    const updated = await runWithPaymentRetry(this.uow, async (tx) => {
      const row = await this.payments.updateState(
        payment.id,
        { status: PaymentStatus.INITIATED, providerRef },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: input.customerUserId,
          action: 'PAYMENT_AUTHORIZATION_PENDING',
          resourceType: 'Payment',
          resourceId: payment.id,
          context: {
            ...this.auditContext(row),
            outcome: 'PENDING',
            providerRef,
            // Whether a redirect was issued, never the URL itself — it can carry gateway tokens.
            redirectIssued: Boolean(result.redirectUrl),
          },
        },
        tx,
      );
      return row;
    });

    return this.toResult(updated, result.redirectUrl ?? null, false);
  }

  private toNewPaymentData(props: PaymentProps): NewPaymentData {
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
    };
  }

  /**
   * What §13 requires an authorization audit entry to identify: actor (carried separately as
   * `actorUserId`), order, payment, amount/currency, method — and the outcome, added by each
   * call site. **Never** the provider token, the redirect URL, or any provider payload.
   */
  private auditContext(payment: PaymentProps): Record<string, unknown> {
    return {
      orderId: payment.orderId,
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      provider: payment.provider,
    };
  }

  private toResult(
    payment: PaymentProps,
    providerRedirect: string | null,
    replay: boolean,
  ): AuthorizePaymentResult {
    return {
      paymentId: payment.id,
      status: payment.status,
      providerRedirect,
      amount: payment.amount,
      currency: payment.currency,
      provider: payment.provider,
      providerRef: payment.providerRef,
      replay,
    };
  }
}
