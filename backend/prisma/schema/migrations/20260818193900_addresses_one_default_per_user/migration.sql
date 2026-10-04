-- Enforces "exactly one default address per user" at the database level (module-02 §6.3,
-- BRULE-21 adjacent invariant). Prisma cannot express a partial/filtered unique index
-- declaratively in this schema-folder setup, so it is added here as a raw-SQL follow-up
-- migration. This makes the invariant crash-safe under concurrency: two parallel
-- "set default" requests can never both leave `isDefault = true` on more than one row.
CREATE UNIQUE INDEX "addresses_one_default_per_user"
  ON "addresses" ("userId")
  WHERE "isDefault" = true AND "deletedAt" IS NULL;
