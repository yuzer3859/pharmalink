-- Module 07 — Payment, Wallet & Settlement: ledger + payment foundation
-- (architecture/module-07-payment-wallet.md §5/§6/§7, ADR-005, ADR-006).
--
-- The Phase-0 init migration already created `payments`, `ledger_accounts`,
-- `ledger_transactions`, `ledger_entries` and `account_balances` as placeholders. This migration
-- makes them match the approved Module 07 design and adds the invariants Postgres can actually
-- enforce by itself. It never touches Module 06: nothing in Modules 01–06 writes `payments` or
-- any ledger table (Slice-1 checkout is COD-only and leaves `Order.paymentId` NULL), so every
-- statement below runs against empty tables.

-- ---------------------------------------------------------------------------------------------
-- 1. `PaymentStatus` — replace the placeholder enum with the §6 state machine's own states.
--    `PENDING` -> `INITIATED` and `CANCELLED` -> `VOIDED` (an authorization cancelled before
--    capture); `SETTLED` and `EXPIRED` are added. The USING clause maps any hypothetical legacy
--    row rather than assuming emptiness.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "payments" ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "PaymentStatus" RENAME TO "PaymentStatus_old";

CREATE TYPE "PaymentStatus" AS ENUM (
    'INITIATED',
    'AUTHORIZED',
    'CAPTURED',
    'SETTLED',
    'FAILED',
    'VOIDED',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'EXPIRED'
);

ALTER TABLE "payments"
    ALTER COLUMN "status" TYPE "PaymentStatus"
    USING (
        CASE "status"::text
            WHEN 'PENDING' THEN 'INITIATED'
            WHEN 'CANCELLED' THEN 'VOIDED'
            ELSE "status"::text
        END
    )::"PaymentStatus";

ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'INITIATED';

DROP TYPE "PaymentStatus_old";

-- ---------------------------------------------------------------------------------------------
-- 2. Row-level CHECK constraints.
--
--    These are deliberately limited to invariants a single row can decide. The double-entry
--    balance invariant (SUM(debits) = SUM(credits) per transaction) spans many rows and CANNOT be
--    expressed as a row-level CHECK — it is enforced by `LedgerService` + the atomic
--    `PrismaLedgerRepository.createTransaction` write, never pretended to be a database
--    constraint here.
--
--    Currency is intentionally NOT pinned to 'ETB' in the database: `ledger_accounts` is keyed by
--    (type, ownerId, currency) precisely so a non-ETB account can exist later, and `payments`
--    stores a foreign `originalCurrency` for cross-border captures (BRULE-22). "Slice-1 is ETB
--    only" lives in the `Money`/`Currency` value objects, mirroring Module 04's `Money.of`.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "ledger_entries_amount_positive_check" CHECK ("amount" > 0);

ALTER TABLE "payments"
    ADD CONSTRAINT "payments_amount_positive_check" CHECK ("amount" > 0);

-- Cross-border FX (§8): the original amount, its currency and the applied rate are meaningless
-- apart from one another, so a payment carries all three or none. `fxSource` is excluded on
-- purpose — it is provenance metadata, not part of the conversion itself.
ALTER TABLE "payments"
    ADD CONSTRAINT "payments_fx_triple_check" CHECK (
        (
            "originalAmount" IS NULL
            AND "originalCurrency" IS NULL
            AND "fxRate" IS NULL
        )
        OR (
            "originalAmount" IS NOT NULL
            AND "originalCurrency" IS NOT NULL
            AND "fxRate" IS NOT NULL
            AND "originalAmount" > 0
            AND "fxRate" > 0
        )
    );

-- ---------------------------------------------------------------------------------------------
-- 3. Index supporting entry-by-transaction reads (`ledger_entries.accountId` is already indexed
--    by the init migration and carries the balance derivation).
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "ledger_entries_transactionId_idx" ON "ledger_entries"("transactionId");

-- ---------------------------------------------------------------------------------------------
-- 4. Append-only enforcement for the ledger (ADR-006 "Never mutate a ledger row";
--    module-07 design §5/§7 "immutable"). The repository layer already exposes no update/delete
--    path, but the ledger is the financial audit trail: a trigger makes the guarantee hold for
--    ad-hoc SQL, a future careless migration, or a mistaken repository method too.
--
--    Row-level triggers do NOT fire on TRUNCATE, so `test/support/test-database.ts`'s
--    `resetDatabase()` (TRUNCATE ... CASCADE) keeps working unchanged.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "ledger_reject_mutation"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'ledger rows are append-only (ADR-006): % on % is not permitted',
        TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_transactions_append_only"
    BEFORE UPDATE OR DELETE ON "ledger_transactions"
    FOR EACH ROW EXECUTE FUNCTION "ledger_reject_mutation"();

CREATE TRIGGER "ledger_entries_append_only"
    BEFORE UPDATE OR DELETE ON "ledger_entries"
    FOR EACH ROW EXECUTE FUNCTION "ledger_reject_mutation"();

-- ---------------------------------------------------------------------------------------------
-- 5. Chart-of-accounts uniqueness for platform-level accounts.
--
--    `ledger_accounts` is keyed by (type, ownerId, currency) — but `ownerId` is NULL for every
--    platform-level account (PLATFORM_REVENUE, GATEWAY_CLEARING, REFUNDS_PAYABLE, COD_CLEARING,
--    FX_GAINLOSS), and Postgres treats NULLs as DISTINCT in a unique index. The init migration's
--    `ledger_accounts_type_ownerId_currency_key` therefore does **not** prevent a second
--    PLATFORM_REVENUE/ETB account from being opened: two concurrent first-use "open the revenue
--    account" calls would both insert, and platform revenue would silently split across two
--    accounts that no balance query joins back together.
--
--    This partial unique index covers exactly the rows the composite index cannot. (A partial
--    index is used rather than `UNIQUE NULLS NOT DISTINCT` so the constraint does not depend on
--    Postgres >= 15.) Owner-scoped accounts keep relying on the composite index, which is
--    already sound for them because `ownerId` is NOT NULL there.
-- ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX "ledger_accounts_platform_type_currency_key"
    ON "ledger_accounts"("type", "currency")
    WHERE "ownerId" IS NULL;
