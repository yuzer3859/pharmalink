-- Enforces "no two MEDICINE products with the same generic name + strength + form +
-- manufacturer" at the database level (module-03 §6.2, BR-CAT-08/§3.6 invariant 4). Prisma
-- cannot express a partial/filtered unique index declaratively in this schema-folder setup
-- (same limitation Module 02 hit for `addresses_one_default_per_user`), so this is added here
-- as a raw-SQL follow-up migration. This makes the invariant crash-safe under concurrency: two
-- admins can never both create/edit into the same duplicate medicine.
--
-- `manufacturerId` is required at the business-rule level for every MEDICINE product (§3.6
-- invariant 8, resolved by Architect review §14.6), so every row this index can match always has
-- a non-null `manufacturerId` — the NULL-collision gap Postgres would otherwise allow (NULL is
-- never equal to NULL in a unique index) cannot occur in practice.
-- `lower("genericName")` matches the case-insensitive comparison the application layer already
-- performs (module-03 §3.6 invariant 4: "case-insensitive on genericName") — using the raw
-- column here would let "Amoxicillin" and "amoxicillin" collide as duplicates in the app layer
-- but not in this index, reopening the exact race the index exists to close.
CREATE UNIQUE INDEX "products_medicine_dedup_key"
  ON "products" (lower("genericName"), "strengthValue", "strengthUnit", "dosageForm", "manufacturerId")
  WHERE "type" = 'MEDICINE' AND "deletedAt" IS NULL;
