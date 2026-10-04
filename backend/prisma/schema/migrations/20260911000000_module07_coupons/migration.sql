-- Module 07 — Payment, Wallet & Settlement: coupons & discounts
-- (architecture/module-07-payment-wallet.md §3.4, §5.1, §7, §9.5, F-CPN-01..03).
--
-- The Phase-0 init migration already created `coupons` and `coupon_redemptions` with exactly the
-- columns §7 specifies, the `coupons_code_key` unique index, the
-- `coupon_redemptions_couponId_orderId_key` unique index that makes "one coupon per order" a
-- database fact, and the `coupon_redemptions_couponId_fkey` foreign key. None of that is
-- recreated or altered here.
--
-- What this migration adds is what the feature actually needs from the database, and nothing
-- changes an existing structure:
--
--   1. indexes for the two usage counts. F-CPN-02's global and per-user limits are both
--      `COUNT(*) WHERE status = 'APPLIED'`, run on every validation and again inside the
--      Serializable transaction that applies a coupon — there is no counter column to read
--      instead (see 3 below);
--   2. an index on `coupons.isActive` for §9.5's admin listing;
--   3. row-level positivity CHECKs, so a misconfigured coupon or a zero-value redemption cannot
--      be stored even by a path that bypassed the domain.
--
-- Deliberately NOT added:
--
--   * a `usage_count` / `times_redeemed` counter on `coupons`. Usage is derived from APPLIED
--     redemption rows, exactly as a ledger balance is derived from entries (ADR-006, §5.3). A
--     counter would be a second source of truth for how much of a promotion has been given away,
--     free to drift from the rows it claims to summarize — and it is also what makes F-CPN-03's
--     reversal work with no compensating write at all: a REVERSED row simply stops being counted.
--
--   * a database constraint for "COUNT(applied redemptions) <= usage_limit_global". Like the
--     double-entry balance invariant and the over-refund invariant before it, this spans many
--     rows and cannot be expressed as a row-level CHECK. It is enforced by counting and inserting
--     inside one Serializable transaction (ADR-013), where PostgreSQL's SSI aborts one of two
--     concurrent applications that each counted the same remaining capacity — see
--     `ApplyCouponCommand`. The per-user limit is enforced the same way; only the per-*order*
--     rule has a real constraint behind it, the pre-existing unique index.
--
--   * an `updated_at` column on `coupons`. §7 lists only `created_at`, and who changed a
--     promotion and when is recorded in the hash-chained audit log (§13), which is where that
--     question belongs and where it cannot be overwritten by the next edit.
--
--   * a `reversed_at` column on `coupon_redemptions`, for the same reason.
--
-- No ledger, payment, refund, wallet or settlement structure is touched by this migration.

-- 1. Usage counting (F-CPN-02).
CREATE INDEX "coupon_redemptions_couponId_status_idx"
  ON "coupon_redemptions" ("couponId", "status");

CREATE INDEX "coupon_redemptions_couponId_userId_status_idx"
  ON "coupon_redemptions" ("couponId", "userId", "status");

-- 2. Admin listing (§9.5).
CREATE INDEX "coupons_isActive_idx" ON "coupons" ("isActive");

-- 3. Positivity. Zero is rejected alongside negatives everywhere: a zero-value coupon discounts
--    nothing, a zero maxDiscount caps every discount at nothing, a zero usage limit makes the
--    coupon unusable, and a zero-value redemption would consume a usage while discounting
--    nothing. Each is a misconfiguration that would otherwise fail silently at redemption time.
ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_value_positive_check" CHECK ("value" > 0);

ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_min_spend_positive_check"
  CHECK ("minSpend" IS NULL OR "minSpend" > 0);

ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_max_discount_positive_check"
  CHECK ("maxDiscount" IS NULL OR "maxDiscount" > 0);

ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_usage_limit_global_positive_check"
  CHECK ("usageLimitGlobal" IS NULL OR "usageLimitGlobal" > 0);

ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_usage_limit_per_user_positive_check"
  CHECK ("usageLimitPerUser" IS NULL OR "usageLimitPerUser" > 0);

-- A PERCENT coupon's `value` is whole percent, 1-100 (see `CouponProps.value` for why whole
-- percent rather than basis points, and for the alternative reading). Over 100% would pay the
-- customer to order.
ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_percent_value_range_check"
  CHECK ("discountType" <> 'PERCENT' OR "value" BETWEEN 1 AND 100);

-- A validity window that ends before it starts can never be satisfied.
ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_window_ordered_check"
  CHECK ("startsAt" IS NULL OR "expiresAt" IS NULL OR "startsAt" < "expiresAt");

ALTER TABLE "coupon_redemptions"
  ADD CONSTRAINT "coupon_redemptions_discount_positive_check"
  CHECK ("discountAmount" > 0);
