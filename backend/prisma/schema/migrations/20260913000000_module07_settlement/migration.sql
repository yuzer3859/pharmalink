-- Module 07 — Settlement & Reconciliation foundation
-- (architecture/module-07-payment-wallet.md §3.5 F-STL-01/02, §7, §11.5, BRULE-23).
--
-- The Phase-0 init migration already created `settlements` and `payout_lines`. Nothing has ever
-- written to them — there was no settlement code — and their original columns cannot express what
-- a statement has to say now, for two reasons that only became true later:
--
--   1. **ADR-019's platform-funded coupons.** A capture may credit `PROVIDER_PAYABLE` *more* than
--      the customer paid, with the difference booked as `PROMOTION_EXPENSE`. The original
--      `settlements` row had `grossAmount`/`platformFeeTotal`/`refundClawback`/`netAmount` and no
--      way to say "2,000 of this payable was funded by the platform, not by the customer". A
--      statement that cannot show that is a statement a pharmacy cannot check.
--   2. **Refunds are postings, not order amendments.** The original `payout_lines` was
--      `(orderId, gross, platformFee, net)` — one row per order, with no sign and no link to the
--      ledger. A partial refund is a separate `REFUND-<refundId>` posting that debits the payable;
--      it has no place in that shape. Lines are therefore keyed on the **ledger transaction**, the
--      thing that actually happened, and carry signed deltas so a capture and the refund reversing
--      it simply sum.
--
-- `orderId` becomes nullable as part of that: a line is derived from a posting, and the order is a
-- label resolved from the payment when one exists, never the source of the figures.
--
-- Every column added here is additive and the tables are empty, so this rewrites no history. It
-- also creates no ledger rows and moves no money: settlement *reads* the ledger. The `SETTLEMENT`
-- posting that accompanies a real payout (§11.5's `ExecutePayout`) is deliberately not part of
-- this task — recording money as sent before anything can send it would be the one unrecoverable
-- mistake available here.

-- ---------------------------------------------------------------------------------------------
-- settlements
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "settlements"
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'ETB',
  ADD COLUMN IF NOT EXISTS "promotionExpense" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "customerCashCollected" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lineCount" INTEGER NOT NULL DEFAULT 0;

-- The idempotency key. A settlement run is made repeatable by the database refusing a second
-- statement for the same provider, period and currency — the same discipline every other money
-- operation in this module uses (`ledger_transactions.reference`,
-- `coupon_redemptions (couponId, orderId)`), never a second bespoke mechanism in application code.
CREATE UNIQUE INDEX IF NOT EXISTS "settlements_pharmacyId_periodStart_periodEnd_currency_key"
  ON "settlements" ("pharmacyId", "periodStart", "periodEnd", "currency");

CREATE INDEX IF NOT EXISTS "settlements_pharmacyId_periodStart_idx"
  ON "settlements" ("pharmacyId", "periodStart");

-- Arithmetic the statement must never contradict. Enforced in the row as well as in the aggregate
-- so a path that bypassed the domain still cannot store a self-inconsistent statement. Signed
-- columns are deliberately unconstrained: a period containing only refunds legitimately has a
-- negative net payable — a pharmacy that owes money back — and clamping that to zero would forgive
-- a real debt.
ALTER TABLE "settlements"
  DROP CONSTRAINT IF EXISTS "settlements_net_matches_gross_minus_clawback";
ALTER TABLE "settlements"
  ADD CONSTRAINT "settlements_net_matches_gross_minus_clawback"
  CHECK ("netAmount" = "grossAmount" - "refundClawback");

ALTER TABLE "settlements"
  DROP CONSTRAINT IF EXISTS "settlements_non_negative_components";
ALTER TABLE "settlements"
  ADD CONSTRAINT "settlements_non_negative_components"
  CHECK ("grossAmount" >= 0 AND "refundClawback" >= 0 AND "lineCount" >= 0);

ALTER TABLE "settlements"
  DROP CONSTRAINT IF EXISTS "settlements_period_ordered";
ALTER TABLE "settlements"
  ADD CONSTRAINT "settlements_period_ordered"
  CHECK ("periodStart" < "periodEnd");

-- ---------------------------------------------------------------------------------------------
-- payout_lines
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "payout_lines"
  ADD COLUMN IF NOT EXISTS "ledgerTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "ledgerReference" TEXT,
  ADD COLUMN IF NOT EXISTS "transactionType" "LedgerTransactionType",
  ADD COLUMN IF NOT EXISTS "sourceRefType" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceRefId" TEXT,
  ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'ETB',
  ADD COLUMN IF NOT EXISTS "providerPayableDelta" INTEGER,
  ADD COLUMN IF NOT EXISTS "platformRevenueDelta" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "promotionExpenseDelta" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "customerCashDelta" INTEGER NOT NULL DEFAULT 0;

-- The table is empty, so the new identifying columns can be made NOT NULL outright rather than
-- backfilled. `gross`/`platformFee`/`net` are dropped for the same reason: keeping unused columns
-- that mean something subtly different from the new ones would invite a later reader to sum the
-- wrong pair.
ALTER TABLE "payout_lines"
  ALTER COLUMN "ledgerTransactionId" SET NOT NULL,
  ALTER COLUMN "ledgerReference" SET NOT NULL,
  ALTER COLUMN "transactionType" SET NOT NULL,
  ALTER COLUMN "occurredAt" SET NOT NULL,
  ALTER COLUMN "providerPayableDelta" SET NOT NULL,
  ALTER COLUMN "orderId" DROP NOT NULL;

ALTER TABLE "payout_lines"
  DROP COLUMN IF EXISTS "gross",
  DROP COLUMN IF EXISTS "platformFee",
  DROP COLUMN IF EXISTS "net";

-- One line per posting per statement: the database's guard against a run counting a single capture
-- twice into the same statement.
CREATE UNIQUE INDEX IF NOT EXISTS "payout_lines_settlementId_ledgerTransactionId_key"
  ON "payout_lines" ("settlementId", "ledgerTransactionId");

CREATE INDEX IF NOT EXISTS "payout_lines_settlementId_idx" ON "payout_lines" ("settlementId");
CREATE INDEX IF NOT EXISTS "payout_lines_ledgerTransactionId_idx"
  ON "payout_lines" ("ledgerTransactionId");

-- Settlement reads one provider's payable entries for a window. Without this the query degrades to
-- a scan of every entry ever written as the ledger grows.
CREATE INDEX IF NOT EXISTS "ledger_entries_accountId_createdAt_idx"
  ON "ledger_entries" ("accountId", "createdAt");
