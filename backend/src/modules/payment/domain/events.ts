import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

/**
 * Payment domain event types (`architecture/module-07-payment-wallet.md` §10, matching
 * `00-domain-event-catalog.md`'s Module 07 rows verbatim — payload fields included).
 *
 * The four `Payment`-aggregate lifecycle events, the wallet task's `WalletCredited`/
 * `WalletDebited` rows, and the coupon task's `CouponRedeemed`/`CouponReversed` — each defined
 * only once its triggering code exists. `SettlementPaid` and `FraudFlagged` are still **not**
 * defined here: no settlement or fraud code exists yet, and each belongs to the task that raises
 * it. That is Module 06's own "no speculative event with no reachable trigger" discipline,
 * applied here.
 *
 * This file defines event *shapes* only. Events are written to the `outbox` table in the same
 * transaction as the state change that produced them (ADR-010, §10's `infrastructure/outbox/`)
 * by the payment commands — no `OutboxService` wiring is part of this foundation task, exactly as
 * Module 06's `domain/events.ts` predated its own command layer.
 */
export const PaymentEventType = {
  PaymentAuthorized: 'payment.authorized',
  PaymentCaptured: 'payment.captured',
  PaymentFailed: 'payment.failed',
  PaymentRefunded: 'payment.refunded',
} as const;

/**
 * The catalog's Module 07 wallet rows — `WalletCredited` / `WalletDebited`, payload `userId,
 * amount`, consumed by Module 13 (notifications). Dotted lower-case type strings, matching
 * `PaymentEventType`'s own mapping of the catalog's PascalCase names.
 *
 * Exactly these two, and no more. `wallet.balance_changed`, `wallet.hold_created` and
 * `wallet.topup_pending` are **not** catalogued and are not invented here — a balance is derived
 * rather than "changed", and no hold mechanism exists (see `WalletAccountingService`).
 */
export const WalletEventType = {
  WalletCredited: 'wallet.credited',
  WalletDebited: 'wallet.debited',
} as const;

/**
 * The coupon lifecycle events (§10's own `domain/events/` listing, which names `CouponRedeemed`).
 * Dotted lower-case type strings, matching the mapping the two blocks above use.
 *
 * **A catalog gap, recorded rather than papered over.** `00-domain-event-catalog.md`'s Module 07
 * table has no coupon row at all — it lists the four payment events, the two wallet events,
 * `SettlementPaid` and `FraudFlagged`, and stops. So `CouponRedeemed` is named by the module
 * design but carries no catalogued payload and no catalogued consumer, and `CouponReversed`
 * (which F-CPN-03 plainly requires a signal for) is named nowhere at all. The payload below is
 * therefore taken from §13's own required audit fields for coupon redeem/reverse, which is the
 * closest thing to an authoritative field list the design provides.
 *
 * Exactly these two, and no more. `coupon.validated` is **not** here: validating a coupon changes
 * nothing and commits no one to anything, so there is no state change for an event to announce.
 * `coupon.created`/`coupon.updated` are not here either — admin curation is recorded in the
 * hash-chained audit log (§13), which is where "who changed this promotion" belongs.
 */
export const CouponEventType = {
  CouponRedeemed: 'coupon.redeemed',
  CouponReversed: 'coupon.reversed',
} as const;

/** Consumed by Module 06 to confirm the order (BRULE-17, §11.1). */
export interface PaymentAuthorizedPayload {
  paymentId: string;
  orderId: string;
}

/** `fee` is the platform commission credited to `PLATFORM_REVENUE` at capture (BRULE-23), in ETB
 * minor units — the catalog's own payload field for this event. */
export interface PaymentCapturedPayload {
  paymentId: string;
  orderId: string;
  fee: number;
}

/** Consumed by Module 06 to compensate the checkout saga, and by Module 13 to notify (§11.2). */
export interface PaymentFailedPayload {
  paymentId: string;
  orderId: string;
  reason: string;
}

/** `amount` is the refunded amount in ETB minor units (BRULE-24). */
export interface PaymentRefundedPayload {
  paymentId: string;
  amount: number;
}

export function paymentAuthorizedEvent(
  payload: PaymentAuthorizedPayload,
): DomainEvent<PaymentAuthorizedPayload> {
  return createDomainEvent({
    type: PaymentEventType.PaymentAuthorized,
    aggregateType: 'Payment',
    aggregateId: payload.paymentId,
    payload,
  });
}

export function paymentCapturedEvent(
  payload: PaymentCapturedPayload,
): DomainEvent<PaymentCapturedPayload> {
  return createDomainEvent({
    type: PaymentEventType.PaymentCaptured,
    aggregateType: 'Payment',
    aggregateId: payload.paymentId,
    payload,
  });
}

export function paymentFailedEvent(
  payload: PaymentFailedPayload,
): DomainEvent<PaymentFailedPayload> {
  return createDomainEvent({
    type: PaymentEventType.PaymentFailed,
    aggregateType: 'Payment',
    aggregateId: payload.paymentId,
    payload,
  });
}

export function paymentRefundedEvent(
  payload: PaymentRefundedPayload,
): DomainEvent<PaymentRefundedPayload> {
  return createDomainEvent({
    type: PaymentEventType.PaymentRefunded,
    aggregateType: 'Payment',
    aggregateId: payload.paymentId,
    payload,
  });
}

/**
 * The catalog's payload for both wallet events, verbatim: `userId, amount`. `amount` is always
 * **positive** ETB minor units — the direction is carried by which of the two events was raised,
 * not by the sign, so a consumer can never misread a debit as a credit.
 *
 * Deliberately absent: the resulting balance. A balance is `Σ credits − Σ debits` at read time
 * (§5.3, ADR-006); embedding one in an event would publish a figure that is stale the moment a
 * concurrent posting lands, and would invite consumers to treat it as authoritative.
 */
export interface WalletMovementPayload {
  userId: string;
  amount: number;
}

/** Raised when money enters a customer's wallet — a top-up, or a refund with `WALLET` destination. */
export function walletCreditedEvent(
  payload: WalletMovementPayload,
): DomainEvent<WalletMovementPayload> {
  return createDomainEvent({
    type: WalletEventType.WalletCredited,
    // The wallet is a projection over the customer's ledger account (§5.1), so the customer is
    // the aggregate it is identified by; there is no separate wallet row to carry an id.
    aggregateType: 'Wallet',
    aggregateId: payload.userId,
    payload,
  });
}

/** Raised when money leaves a customer's wallet — a checkout spend (§11.6). */
export function walletDebitedEvent(
  payload: WalletMovementPayload,
): DomainEvent<WalletMovementPayload> {
  return createDomainEvent({
    type: WalletEventType.WalletDebited,
    aggregateType: 'Wallet',
    aggregateId: payload.userId,
    payload,
  });
}

/**
 * The payload for both coupon events: which promotion, which customer, which order, and how much
 * was discounted — §13's required fields for a coupon redemption and its reversal, verbatim.
 *
 * `discountAmount` is always **positive** ETB minor units; the direction is carried by which of
 * the two events was raised, not by the sign, so a consumer cannot misread a reversal as a
 * discount. Deliberately absent: the coupon *code*. It is a promotion identifier rather than a
 * secret, but a published event is the widest surface in the system and `couponId` identifies the
 * promotion for every consumer that legitimately needs it.
 */
export interface CouponMovementPayload {
  couponId: string;
  userId: string;
  orderId: string;
  discountAmount: number;
}

/** Raised when a coupon is applied to an order and a usage is consumed (F-CPN-02). */
export function couponRedeemedEvent(
  payload: CouponMovementPayload,
): DomainEvent<CouponMovementPayload> {
  return createDomainEvent({
    type: CouponEventType.CouponRedeemed,
    // The redemption is the record; the coupon is the aggregate it belongs to (§5.1 — `Coupon`
    // is the aggregate root, `CouponRedemption` its usage record).
    aggregateType: 'Coupon',
    aggregateId: payload.couponId,
    payload,
  });
}

/** Raised when a redemption is reversed and its usage returns to the pool (F-CPN-03). */
export function couponReversedEvent(
  payload: CouponMovementPayload,
): DomainEvent<CouponMovementPayload> {
  return createDomainEvent({
    type: CouponEventType.CouponReversed,
    aggregateType: 'Coupon',
    aggregateId: payload.couponId,
    payload,
  });
}
