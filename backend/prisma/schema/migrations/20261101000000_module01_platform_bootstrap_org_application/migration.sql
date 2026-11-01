-- Module 01 — Identity: one-time first Super Admin bootstrap and pharmacy organisation applications
-- (Work 65).
--
-- `platform_bootstrap` records that the first Super Admin was created by the operator-only CLI
-- (`npm run admin:bootstrap-super-admin`). At most one row can ever exist: the primary key must be
-- the fixed value 'FIRST_SUPER_ADMIN'. The row is written in the same transaction as that account,
-- its SUPER_ADMIN assignment and the audit entry, and a trigger refuses any UPDATE or DELETE, so
-- the bootstrap stays consumed for the life of the database even if the account is later changed.
--
-- `organizations.applicationKey` is the owner-scoped retry key of `POST /organizations/pharmacy`.
-- The (ownerUserId, applicationKey) unique index makes a resubmitted application return the same
-- organisation instead of creating a second one. Existing rows keep NULL, and NULLs never collide.
--
-- Purely additive (ADR-003): a new nullable column, a new table, two indexes, a CHECK constraint and
-- a guard trigger. No existing row changes.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "applicationKey" TEXT;

-- CreateTable
CREATE TABLE "platform_bootstrap" (
    "key" TEXT NOT NULL,
    "superAdminUserId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_bootstrap_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "platform_bootstrap_singleton" CHECK ("key" = 'FIRST_SUPER_ADMIN')
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_bootstrap_superAdminUserId_key" ON "platform_bootstrap"("superAdminUserId");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_ownerUserId_applicationKey_key" ON "organizations"("ownerUserId", "applicationKey");

-- AddForeignKey
ALTER TABLE "platform_bootstrap" ADD CONSTRAINT "platform_bootstrap_superAdminUserId_fkey" FOREIGN KEY ("superAdminUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The bootstrap record is write-once.
CREATE FUNCTION "platform_bootstrap_write_once"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform_bootstrap is write-once: the first Super Admin bootstrap cannot be undone or changed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "platform_bootstrap_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "platform_bootstrap"
  FOR EACH ROW EXECUTE FUNCTION "platform_bootstrap_write_once"();
