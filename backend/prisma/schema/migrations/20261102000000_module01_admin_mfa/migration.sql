-- Module 01 — Identity: mandatory administrator MFA (Work 66).
--
-- Platform administrators (primaryRole ADMIN or SUPER_ADMIN, or a global PLATFORM-scoped ADMIN or
-- SUPER_ADMIN assignment) must complete authenticator-app TOTP (RFC 6238) before any session is
-- issued to them.
--
-- - `admin_mfa_credentials`: one enrolled authenticator per user. The TOTP secret is AES-256-GCM
--   ciphertext under ADMIN_MFA_ENCRYPTION_KEY (never plaintext, never the key). `lastUsedStep` is
--   the highest accepted TOTP time step: a conditional update on it is what stops a code from
--   being replayed, including by two concurrent requests.
-- - `admin_mfa_challenges`: short-lived challenges issued after the password factor. Only the
--   SHA-256 hash of the challenge token is stored; attempts, expiry and consumption are enforced
--   with conditional updates.
-- - `admin_mfa_recovery_codes`: single-use recovery codes, stored only as SHA-256 hashes.
-- - `sessions.mfaVerifiedAt` / `refresh_tokens.mfaVerifiedAt`: MFA assurance of a session and of
--   its refresh-token family. Every existing row stays NULL: no session that existed before this
--   migration is ever treated as MFA-verified, so an administrator's pre-MFA refresh token is
--   rejected at its next use.
--
-- Additive (ADR-003) apart from the rollout statement at the end, which only increments
-- `users.permVersion` for platform administrators.

-- CreateEnum
CREATE TYPE "AdminMfaChallengePurpose" AS ENUM ('ENROLL', 'VERIFY');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "mfaVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "mfaVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "admin_mfa_credentials" (
    "userId" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "lastUsedStep" BIGINT,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_mfa_credentials_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "admin_mfa_credentials_last_used_step_check" CHECK ("lastUsedStep" IS NULL OR "lastUsedStep" >= 0)
);

-- CreateTable
CREATE TABLE "admin_mfa_challenges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "AdminMfaChallengePurpose" NOT NULL,
    "replacesCredential" BOOLEAN NOT NULL DEFAULT false,
    "encryptedPendingSecret" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_mfa_challenges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_mfa_challenges_attempts_check" CHECK ("attempts" >= 0),
    -- Only an enrolment challenge carries a pending secret or replaces an authenticator.
    CONSTRAINT "admin_mfa_challenges_enroll_fields_check" CHECK (
        "purpose" = 'ENROLL' OR ("encryptedPendingSecret" IS NULL AND "replacesCredential" = false)
    )
);

-- CreateTable
CREATE TABLE "admin_mfa_recovery_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_mfa_challenges_tokenHash_key" ON "admin_mfa_challenges"("tokenHash");

-- CreateIndex
CREATE INDEX "admin_mfa_challenges_userId_idx" ON "admin_mfa_challenges"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "admin_mfa_recovery_codes_userId_codeHash_key" ON "admin_mfa_recovery_codes"("userId", "codeHash");

-- AddForeignKey
ALTER TABLE "admin_mfa_credentials" ADD CONSTRAINT "admin_mfa_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_mfa_challenges" ADD CONSTRAINT "admin_mfa_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_mfa_recovery_codes" ADD CONSTRAINT "admin_mfa_recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rollout: invalidate every access token already issued to a platform administrator. Bumping
-- `permVersion` makes JwtAuthGuard reject those tokens (TOKEN_EXPIRED); the refresh that would
-- follow is rejected because the token family has no MFA assurance (AUTH_MFA_REQUIRED). The
-- administrator then signs in again and completes MFA. Non-administrators are untouched.
-- (test/identity/admin-mfa.e2e-spec.ts runs this statement, between the markers, against the
-- disposable test database.)
-- rollout:begin
UPDATE "users" AS u
SET "permVersion" = u."permVersion" + 1
WHERE u."primaryRole" IN ('ADMIN', 'SUPER_ADMIN')
   OR EXISTS (
        SELECT 1
        FROM "user_roles" AS ur
        JOIN "roles" AS r ON r."id" = ur."roleId"
        WHERE ur."userId" = u."id"
          AND ur."organizationId" IS NULL
          AND r."scope" = 'PLATFORM'
          AND r."key" IN ('ADMIN', 'SUPER_ADMIN')
   );
-- rollout:end
