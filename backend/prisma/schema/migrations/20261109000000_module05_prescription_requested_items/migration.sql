-- Work 109: what the customer asks for against a prescription, recorded when checkout routes it
-- for review (owner decision 2026-11-09, verify before paying). Additive and nullable.
ALTER TABLE "prescriptions" ADD COLUMN "requestedItems" JSONB;
