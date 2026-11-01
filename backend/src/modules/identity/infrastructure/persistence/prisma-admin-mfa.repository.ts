import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { PLATFORM_ADMIN_ROLE_KEYS } from '../../domain/mfa/privileged-account';
import {
  AdminMfaChallengeRecord,
  AdminMfaCredentialRecord,
  IAdminMfaRepository,
  NewAdminMfaChallenge,
} from '../../domain/repositories/admin-mfa.repository';

type Client = PrismaService | Prisma.TransactionClient;

/** The Work 66 migration; `isSchemaReady` checks that it finished. */
export const ADMIN_MFA_MIGRATION = '20261102000000_module01_admin_mfa';

/**
 * The privileged-account rule as a Prisma filter, shared with `CachedPermVersionStore` so the
 * guard and the session issuers can't disagree about who is an administrator.
 */
export const platformAdminWhere = (userId: string): Prisma.UserWhereInput => ({
  id: userId,
  OR: [
    { primaryRole: { in: [...PLATFORM_ADMIN_ROLE_KEYS] } },
    {
      userRoles: {
        some: {
          organizationId: null,
          role: { scope: 'PLATFORM', key: { in: [...PLATFORM_ADMIN_ROLE_KEYS] } },
        },
      },
    },
  ],
});

const CHALLENGE_SELECT = {
  id: true,
  userId: true,
  purpose: true,
  replacesCredential: true,
  encryptedPendingSecret: true,
  attempts: true,
  expiresAt: true,
  consumedAt: true,
} as const;

/** A challenge that can still be used: unconsumed, unexpired and under the attempt limit. */
const usable = (id: string, now: Date, maxAttempts: number): Prisma.AdminMfaChallengeWhereInput => ({
  id,
  consumedAt: null,
  expiresAt: { gt: now },
  attempts: { lt: maxAttempts },
});

@Injectable()
export class PrismaAdminMfaRepository implements IAdminMfaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async isPlatformAdministrator(userId: string, tx?: unknown): Promise<boolean> {
    const client = (tx as Client) ?? this.prisma;
    return (await client.user.count({ where: platformAdminWhere(userId) })) > 0;
  }

  async findCredential(userId: string, tx?: unknown): Promise<AdminMfaCredentialRecord | null> {
    const client = (tx as Client) ?? this.prisma;
    const row = await client.adminMfaCredential.findUnique({ where: { userId } });
    return row
      ? {
          userId: row.userId,
          encryptedSecret: row.encryptedSecret,
          lastUsedStep: row.lastUsedStep === null ? null : Number(row.lastUsedStep),
          enabledAt: row.enabledAt,
        }
      : null;
  }

  async createChallenge(data: NewAdminMfaChallenge, tx?: unknown): Promise<AdminMfaChallengeRecord> {
    const client = (tx as Client) ?? this.prisma;
    return client.adminMfaChallenge.create({ data, select: CHALLENGE_SELECT });
  }

  async findChallengeByTokenHash(tokenHash: string): Promise<AdminMfaChallengeRecord | null> {
    return this.prisma.adminMfaChallenge.findUnique({ where: { tokenHash }, select: CHALLENGE_SELECT });
  }

  async setPendingSecret(
    challengeId: string,
    encryptedSecret: string,
    now: Date,
    maxAttempts: number,
  ): Promise<boolean> {
    const result = await this.prisma.adminMfaChallenge.updateMany({
      where: { ...usable(challengeId, now, maxAttempts), purpose: 'ENROLL' },
      data: { encryptedPendingSecret: encryptedSecret },
    });
    return result.count === 1;
  }

  async registerFailedAttempt(challengeId: string, now: Date, maxAttempts: number): Promise<void> {
    await this.prisma.adminMfaChallenge.updateMany({
      where: usable(challengeId, now, maxAttempts),
      data: { attempts: { increment: 1 } },
    });
  }

  async consumeChallenge(challengeId: string, now: Date, maxAttempts: number, tx?: unknown): Promise<boolean> {
    const client = (tx as Client) ?? this.prisma;
    const result = await client.adminMfaChallenge.updateMany({
      where: usable(challengeId, now, maxAttempts),
      data: { consumedAt: now },
    });
    return result.count === 1;
  }

  async advanceTimeStep(userId: string, step: number, tx?: unknown): Promise<boolean> {
    const client = (tx as Client) ?? this.prisma;
    const result = await client.adminMfaCredential.updateMany({
      where: { userId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }] },
      data: { lastUsedStep: BigInt(step) },
    });
    return result.count === 1;
  }

  async createCredential(userId: string, encryptedSecret: string, step: number, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    await client.adminMfaCredential.create({
      data: { userId, encryptedSecret, lastUsedStep: BigInt(step) },
    });
  }

  async replaceCredential(userId: string, encryptedSecret: string, step: number, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    await client.adminMfaCredential.upsert({
      where: { userId },
      create: { userId, encryptedSecret, lastUsedStep: BigInt(step) },
      update: { encryptedSecret, lastUsedStep: BigInt(step), enabledAt: new Date() },
    });
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[], tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    await client.adminMfaRecoveryCode.deleteMany({ where: { userId } });
    await client.adminMfaRecoveryCode.createMany({
      data: codeHashes.map((codeHash) => ({ userId, codeHash })),
    });
  }

  async consumeRecoveryCode(userId: string, codeHash: string, now: Date, tx?: unknown): Promise<boolean> {
    const client = (tx as Client) ?? this.prisma;
    const result = await client.adminMfaRecoveryCode.updateMany({
      where: { userId, codeHash, usedAt: null },
      data: { usedAt: now },
    });
    return result.count === 1;
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.prisma.adminMfaRecoveryCode.count({ where: { userId, usedAt: null } });
  }

  async isSchemaReady(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ applied: bigint }>>`
      SELECT COUNT(*)::bigint AS applied
      FROM "_prisma_migrations"
      WHERE "migration_name" = ${ADMIN_MFA_MIGRATION}
        AND "finished_at" IS NOT NULL
        AND "rolled_back_at" IS NULL`;
    return Number(rows[0]?.applied ?? 0) > 0;
  }
}
