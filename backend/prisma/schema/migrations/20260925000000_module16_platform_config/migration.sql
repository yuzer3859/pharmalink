-- Module 16 — Admin & Platform Management, Work 01: platform configuration.
--
-- Adds the versioned configuration table the design's §8 specifies. `feature_flags` and
-- `system_configs` already exist from the Phase-0 init migration and are **not** touched here:
-- `feature_flags` is reused as-is (its shape already covers key/enabled/targeting/updatedBy), and
-- `system_configs` is dead scaffolding that `platform_configs` supersedes — see the doc comment on
-- the model for why it is left in place rather than dropped.

CREATE TYPE "ConfigValueType" AS ENUM ('BOOLEAN', 'INTEGER', 'DECIMAL', 'STRING', 'JSON');

CREATE TABLE "platform_configs" (
    "id"        TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key"       TEXT NOT NULL,
    "value"     JSONB NOT NULL,
    "valueType" "ConfigValueType" NOT NULL,
    "version"   INTEGER NOT NULL,
    "isActive"  BOOLEAN NOT NULL DEFAULT false,
    "reason"    TEXT,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_configs_pkey" PRIMARY KEY ("id")
);

-- One row per version of a setting, and version numbers are never reused. This is also what makes
-- the "next version" write safe under concurrency: two administrators who read version 3 and both
-- try to write version 4 cannot both succeed — one gets a unique violation and retries against the
-- version the winner actually wrote, rather than silently overwriting it.
CREATE UNIQUE INDEX "platform_configs_namespace_key_version_key"
    ON "platform_configs"("namespace", "key", "version");

-- **The single-active-version invariant.**
--
-- A partial unique index over (namespace, key) restricted to the active row. Prisma's schema
-- language cannot express a `WHERE` clause on an index, so it lives here; the model's doc comment
-- points at this migration, the same arrangement `job_offers_one_live_per_job` and
-- `cod_disputes_one_open_per_collection` use.
--
-- Without it, "exactly one active version" would rest entirely on the deactivate-then-activate pair
-- inside the publish transaction being correct forever. With it, the database refuses the second
-- active row outright — so the worst a bug can produce is a failed write rather than a platform
-- running on two different values for the same setting depending on which row a query happened to
-- read first.
CREATE UNIQUE INDEX "platform_configs_one_active_per_key"
    ON "platform_configs"("namespace", "key")
    WHERE "isActive" = true;

-- The snapshot refresh reads every active row; the history read walks one key.
CREATE INDEX "platform_configs_namespace_key_isActive_idx"
    ON "platform_configs"("namespace", "key", "isActive");

-- "What has this administrator changed?" — the oversight question §13 of the design asks.
CREATE INDEX "platform_configs_updatedBy_createdAt_idx"
    ON "platform_configs"("updatedBy", "createdAt");
