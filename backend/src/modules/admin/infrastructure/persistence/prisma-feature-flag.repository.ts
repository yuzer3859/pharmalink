import { Injectable } from '@nestjs/common';
import { Prisma, FeatureFlag as PrismaFeatureFlag } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { FeatureFlagProps } from '../../domain/entities/feature-flag.entity';
import { IFeatureFlagRepository } from '../../domain/repositories/feature-flag.repository';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * `IFeatureFlagRepository` over Prisma (module-16 §8's `feature_flags`).
 *
 * The table is the Phase-0 one, reused rather than replaced: it already carries `key @unique`,
 * `status`, `description` and `updatedByUserId`, which is the whole of what §9 of the work brief
 * asks for. `rolloutPercent` and `targetRules` exist on the row and are **never written here** —
 * they keep their column defaults, because no evaluator in this work could honour them.
 */
@Injectable()
export class PrismaFeatureFlagRepository implements IFeatureFlagRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findByKey(key: string, tx?: unknown): Promise<FeatureFlagProps | null> {
    const row = await this.client(tx).featureFlag.findUnique({ where: { key } });
    return row ? toProps(row) : null;
  }

  async listAll(tx?: unknown): Promise<FeatureFlagProps[]> {
    const rows = await this.client(tx).featureFlag.findMany({ orderBy: { key: 'asc' } });
    return rows.map(toProps);
  }

  async insert(flag: FeatureFlagProps, tx?: unknown): Promise<FeatureFlagProps | null> {
    try {
      const row = await this.client(tx).featureFlag.create({
        data: {
          id: flag.id,
          key: flag.key,
          description: flag.description,
          status: flag.status,
          updatedByUserId: flag.updatedByUserId,
          createdAt: flag.createdAt,
        },
      });
      return toProps(row);
    } catch (err) {
      // The key was taken — two administrators created the same flag at once. The caller re-reads
      // on a fresh connection, for the reason the config repository's `insert` sets out.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Compare-and-set on `status`, so only one of two simultaneous toggles lands.
   *
   * `updateMany` with the expected status in the `where` clause rather than `update` by key:
   * Prisma's `update` would write regardless of the current state, and the row count coming back as
   * `0` is what turns "somebody got here first" into a value the caller can act on instead of a
   * race it cannot see.
   */
  async updateStatus(
    key: string,
    expected: FeatureFlagProps['status'],
    update: {
      status: FeatureFlagProps['status'];
      description: string | null;
      updatedByUserId: string;
      updatedAt: Date;
    },
    tx?: unknown,
  ): Promise<FeatureFlagProps | null> {
    const client = this.client(tx);
    const { count } = await client.featureFlag.updateMany({
      where: { key, status: expected },
      data: {
        status: update.status,
        description: update.description,
        updatedByUserId: update.updatedByUserId,
        updatedAt: update.updatedAt,
      },
    });
    if (count === 0) {
      return null;
    }
    const row = await client.featureFlag.findUnique({ where: { key } });
    return row ? toProps(row) : null;
  }
}

function toProps(row: PrismaFeatureFlag): FeatureFlagProps {
  return {
    id: row.id,
    key: row.key,
    description: row.description,
    status: row.status,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
