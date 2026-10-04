-- Module 07 — Payment, Wallet & Settlement: refunds
-- (architecture/module-07-payment-wallet.md §3.2, §5, §7, §11.4, BRULE-24).
--
-- The Phase-0 init migration already created `refunds` with exactly the columns §7 specifies
-- (id, paymentId, amount, reason, type, destination, status, providerRef, approvedBy,
-- idempotencyKey, createdAt, completedAt), the `refunds_idempotencyKey_key` unique index that
-- BRULE-25's replay safety depends on, and the `refunds_paymentId_fkey` foreign key to
-- `payments`. None of that is recreated or altered here.
--
-- What was missing are the two things this task actually needs from the database, and neither
-- changes an existing structure:
--
--   1. an index on `paymentId`, because every refund decision first reads the sum already
--      refunded against the payment; and
--   2. the row-level positivity CHECK, so a zero or negative refund cannot be stored even by a
--      path that bypassed the domain.
--
-- Deliberately NOT added:
--
--   * a `currency` column. §7's `refunds` has none, and adding one would create a second place a
--     refund's currency could disagree with `payments.currency` — the refund's currency IS the
--     payment's currency, and `RefundPolicy` rejects any request that says otherwise.
--   * a database constraint for "SUM(refunds.amount) <= payments.amount". Like the double-entry
--     balance invariant, it spans many rows and cannot be expressed as a row-level CHECK. It is
--     enforced by reading the sum and inserting the refund inside one `Serializable` transaction
--     (ADR-013), which is what makes two concurrent refunds unable to observe the same remaining
--     amount — see `RefundPaymentCommand`.
--
-- No ledger, payment, wallet, coupon or settlement structure is touched by this migration.

-- ---------------------------------------------------------------------------------------------
-- 1. Refund lookups by payment (`Refund.@@index([paymentId])`).
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

-- ---------------------------------------------------------------------------------------------
-- 2. A refund moves a strictly positive amount of money, exactly like a payment
--    (`payments_amount_positive_check`) and a ledger entry
--    (`ledger_entries_amount_positive_check`). Zero records nothing; negative is a refund written
--    the wrong way round.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "refunds"
    ADD CONSTRAINT "refunds_amount_positive_check" CHECK ("amount" > 0);
