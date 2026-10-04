-- Module 08 — Driver earnings accrual (§3.5 F-ERN-01/F-ERN-02, §8's `driver_earnings`, BR-DEL-10).
--
-- `driver_earnings` has existed since the Phase-0 schema and has never been written to: no code
-- path constructed a row, and `EarningStatus` was deliberately left out of the module's
-- `domain/enums.ts` ("re-exporting them here would advertise a domain that does not exist yet").
-- The table is therefore empty in every environment, and this migration reshapes it rather than
-- migrating data into it.
--
-- It is still written defensively — new NOT NULL columns land with a default and only then lose
-- it — so that it would behave correctly against a database somebody had populated by hand.

-- 1. The natural key.
--
-- **This unique index is the idempotency guarantee** (§6's "Earnings accrue once per completed job
-- (idempotent)"). The outbox is at-least-once by design (ADR-010), so the completion event that
-- triggers accrual *will* sometimes arrive twice, and two concurrent handlers can reach the insert
-- at the same instant. Neither is settleable in application code across two API nodes; Postgres
-- settles both here, and `AccrueDriverEarningCommand` resolves the loser by returning the winner's
-- row — the same shape `CreateDeliveryJobCommand` and `CaptureProofOfDeliveryCommand` already use.
--
-- A duplicate earning is not a cosmetic defect. It is the platform recording that it owes a driver
-- twice for one delivery, and the error would surface as money.
CREATE UNIQUE INDEX "driver_earnings_jobId_key" ON "driver_earnings"("jobId");

-- 2. Module 06 references, as scalars (ADR-002) — never a Prisma relation across contexts.
--
-- Snapshots of the job's own references, frozen at accrual, so a settlement run can answer "which
-- order produced this earning?" without Module 07 joining into Module 08's job table. Added with a
-- placeholder default so the statement is safe against a pre-populated table, then stripped: every
-- genuine accrual resolves both from the delivery job, and a default would let a future insert omit
-- the references a financial reconciliation needs.
ALTER TABLE "driver_earnings" ADD COLUMN "orderId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "driver_earnings" ADD COLUMN "fulfillmentId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "driver_earnings" ALTER COLUMN "orderId" DROP DEFAULT;
ALTER TABLE "driver_earnings" ALTER COLUMN "fulfillmentId" DROP DEFAULT;

-- 3. The fee-share component.
--
-- A fourth named component beside `base`, `distanceComponent` and `incentive`, rather than folded
-- into one of them. The design's Open Question 4 asks "who funds it (platform vs delivery fee
-- split)?", and the honest way to leave that open is to make the split a component that is
-- visibly, auditably **zero** until somebody decides otherwise — not an invisible term inside
-- `base`. Defaults to 0 and stays 0 under the shipped configuration.
ALTER TABLE "driver_earnings" ADD COLUMN "feeShare" INTEGER NOT NULL DEFAULT 0;

-- 4. What the calculation actually used.
--
-- `distanceMeters` is a **copy of the job's frozen distance** (Work 09's `delivery_jobs.distanceMeters`),
-- not a fresh measurement. Nullable because a job can legitimately have no distance — a branch or
-- an address stored without coordinates, or a routing provider that could not answer when the job
-- was cut — and because an earning computed under a zero per-kilometre rate does not need one. What
-- it must never be is a number invented at accrual time to fill the gap.
ALTER TABLE "driver_earnings" ADD COLUMN "distanceMeters" INTEGER;

-- `calculationVersion` is the operator's label for the earning agreement in force. Without it, an
-- amount accrued months ago can only be explained by guessing which rate card produced it, which is
-- exactly the reverse-engineering a settlement must never have to do.
ALTER TABLE "driver_earnings" ADD COLUMN "calculationVersion" TEXT NOT NULL DEFAULT 'v1';

-- 5. The driver's own ledger (`GET /driver/earnings`), newest first.
CREATE INDEX "driver_earnings_driverId_createdAt_idx" ON "driver_earnings"("driverId", "createdAt");
