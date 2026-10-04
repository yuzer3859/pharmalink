/**
 * Re-exported Prisma enums (`prisma/schema/07-payment.prisma`), same pattern as Modules
 * 02/03/04/05/06's own `domain/enums.ts` — the domain layer depends on the enum shape, not on
 * `@prisma/client` as a whole.
 *
 * The design document (§5.2) names three of these slightly differently from the Prisma schema:
 * `EntryDirection`, `AccountType` and `LedgerTxnType`. Those are the *same* enums, not
 * additional ones, so they are exported here as aliases rather than duplicated as hand-written
 * TypeScript enums that would then have to be kept in sync with the database.
 *
 * `RefundStatus` was re-exported by the foundation task ahead of its consumers; the refund task
 * adds `RefundType` (FULL|PARTIAL) and `RefundDestination` (ORIGINAL|WALLET) alongside it, both
 * already present in the schema per §7's `refunds` model. The coupon task adds `DiscountType`
 * (PERCENT|FIXED) and `RedemptionStatus` (APPLIED|REVERSED), both already present in the schema
 * per §7's `coupons`/`coupon_redemptions` models. `SettlementStatus` is still ahead of its own
 * task, but is part of §5.2's enum set and already exists in the schema.
 */
export {
  PaymentMethod,
  PaymentStatus,
  LedgerAccountType,
  LedgerTransactionType,
  LedgerDirection,
  RefundStatus,
  RefundType,
  RefundDestination,
  DiscountType,
  RedemptionStatus,
  SettlementStatus,
} from '@prisma/client';

export {
  LedgerDirection as EntryDirection,
  LedgerAccountType as AccountType,
  LedgerTransactionType as LedgerTxnType,
} from '@prisma/client';
