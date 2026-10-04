-- Module 08 — Proof of Delivery (§3.3 F-STS-04, §5.2, §8, BR-DEL-06, BRULE-29).
--
-- `proof_of_delivery` has existed since the Phase-0 schema but has never been written to: no code
-- path constructed a row, `PodType` was deliberately left out of the module's `domain/enums.ts`
-- ("re-exporting them here would advertise a domain that does not exist yet"), and the
-- proof-of-delivery work is the first with anything to store. The table is therefore empty in
-- every environment, and this migration reshapes it rather than migrating data into it.
--
-- It is still written defensively — new columns land with defaults and only then lose them — so
-- that it would behave correctly against a database somebody had populated by hand.

-- 1. Where the artifact lives, and what it is.
--
-- `artifactRef` becomes NULLABLE, which is the substantive change. The Phase-0 column was NOT
-- NULL, which quietly assumed every proof carries a file; F-STS-04's first listed form is
-- "recipient confirmation", which has no artifact at all, and a NOT NULL reference would have
-- forced a placeholder string into the evidence record to represent its absence.
ALTER TABLE "proof_of_delivery" ALTER COLUMN "artifactRef" DROP NOT NULL;

-- Artifact description, never artifact content. The bytes live behind
-- `IProofArtifactStoragePort`; these columns let a dispute reason about what was captured, and
-- let an integrity claim be checked, without the row ever holding an image.
ALTER TABLE "proof_of_delivery" ADD COLUMN "artifactContentType" TEXT;
ALTER TABLE "proof_of_delivery" ADD COLUMN "artifactBytes" INTEGER;
ALTER TABLE "proof_of_delivery" ADD COLUMN "artifactSha256" TEXT;

-- 2. What the recipient attested.
--
-- Distinct from `recipientName`: a name records *who*, this records *whether*. A PoD whose only
-- content is a name would not say that anybody agreed they had received anything.
ALTER TABLE "proof_of_delivery" ADD COLUMN "recipientConfirmed" BOOLEAN NOT NULL DEFAULT false;

-- 3. Who captured it.
--
-- `driver_profiles.id`, not a Module 01 user id — the question a dispute asks is which operational
-- driver was carrying the job, and that is what every other table in this module is keyed by.
-- Added with a placeholder default so the statement is safe against a pre-populated table, then
-- stripped: every genuine capture supplies it, and a default would let a future insert omit the
-- one field that says who is accountable for the evidence.
ALTER TABLE "proof_of_delivery" ADD COLUMN "capturedByDriverId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "proof_of_delivery" ALTER COLUMN "capturedByDriverId" DROP DEFAULT;

-- 4. What the proof is about.
--
-- Module 06 scalars, denormalised per ADR-002 — copied values, never a relation across the context
-- boundary. Carried so the evidence still names what it proves independently of the job row, and
-- so the customer-facing read, which arrives holding an order id, does not have to join.
ALTER TABLE "proof_of_delivery" ADD COLUMN "orderId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "proof_of_delivery" ALTER COLUMN "orderId" DROP DEFAULT;
ALTER TABLE "proof_of_delivery" ADD COLUMN "fulfillmentId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "proof_of_delivery" ALTER COLUMN "fulfillmentId" DROP DEFAULT;

-- 5. When the row was created, as distinct from when the handover happened.
--
-- `capturedAt` is the driver's account of the moment of delivery and can legitimately be a little
-- behind the clock; `createdAt` is when this platform learned of it. Keeping both is what lets a
-- later question about a retry, a delay or a buffered submission be answered from the row itself.
ALTER TABLE "proof_of_delivery" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 6. Find a delivery's proof by order.
--
-- Postgres does not index a foreign-key column on its own, and `jobId` already carries a unique
-- index from the Phase-0 schema — which is also the immutability guarantee: one proof per job,
-- enforced by the database rather than by an application check, so a retry or a race cannot
-- produce a second piece of evidence for one delivery. `orderId` has no such index and is how the
-- customer-facing read arrives.
CREATE INDEX "proof_of_delivery_orderId_idx" ON "proof_of_delivery"("orderId");
