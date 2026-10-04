import { Injectable } from '@nestjs/common';
import { Prisma, PlatformConfig as PrismaPlatformConfig } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { PlatformConfigProps } from '../../domain/entities/platform-config.entity';
import { ConfigPrimitive } from '../../domain/value-objects/config-value.vo';
import { IPlatformConfigRepository } from '../../domain/repositories/platform-config.repository';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * `IPlatformConfigRepository` over Prisma (module-16 §8's `platform_configs`).
 *
 * ## Append-only in the code as well as in the contract
 *
 * There is no `update`, no `upsert` and no `delete` in this file. The one `updateMany` is
 * `deactivateActive`, which writes a single boolean column and touches no value, type, version or
 * actor — so a published decision cannot be edited through this adapter even by accident.
 *
 * `insert` catches `P2002` on the `(namespace, key, version)` unique index and returns `null`
 * rather than throwing, because two administrators racing the same key is an expected outcome
 * rather than a fault. **It does not re-read the winner here**: a unique violation aborts the
 * enclosing Postgres transaction, so a query issued afterwards on the same connection fails too.
 * The caller unwinds and re-reads on a fresh connection — the discipline Module 08's COD work
 * established against a real database.
 */
@Injectable()
export class PrismaPlatformConfigRepository implements IPlatformConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findActive(
    namespace: string,
    key: string,
    tx?: unknown,
  ): Promise<PlatformConfigProps | null> {
    const row = await this.client(tx).platformConfig.findFirst({
      where: { namespace, key, isActive: true },
    });
    return row ? toProps(row) : null;
  }

  async findAllActive(tx?: unknown): Promise<PlatformConfigProps[]> {
    const rows = await this.client(tx).platformConfig.findMany({
      where: { isActive: true },
      orderBy: [{ namespace: 'asc' }, { key: 'asc' }],
    });
    return rows.map(toProps);
  }

  async listVersions(
    namespace: string,
    key: string,
    tx?: unknown,
  ): Promise<PlatformConfigProps[]> {
    const rows = await this.client(tx).platformConfig.findMany({
      where: { namespace, key },
      orderBy: { version: 'desc' },
    });
    return rows.map(toProps);
  }

  async findVersion(
    namespace: string,
    key: string,
    version: number,
    tx?: unknown,
  ): Promise<PlatformConfigProps | null> {
    const row = await this.client(tx).platformConfig.findUnique({
      where: { namespace_key_version: { namespace, key, version } },
    });
    return row ? toProps(row) : null;
  }

  async maxVersion(namespace: string, key: string, tx?: unknown): Promise<number> {
    const result = await this.client(tx).platformConfig.aggregate({
      where: { namespace, key },
      _max: { version: true },
    });
    return result._max.version ?? 0;
  }

  async insert(
    config: PlatformConfigProps,
    tx?: unknown,
  ): Promise<PlatformConfigProps | null> {
    try {
      const row = await this.client(tx).platformConfig.create({
        data: {
          id: config.id,
          namespace: config.namespace,
          key: config.key,
          value: config.value as Prisma.InputJsonValue,
          valueType: config.valueType,
          version: config.version,
          isActive: config.isActive,
          reason: config.reason,
          updatedBy: config.updatedBy,
          createdAt: config.createdAt,
        },
      });
      return toProps(row);
    } catch (err) {
      // Either the version was taken, or another transaction already holds the active row for this
      // key. Both are the same lost race from the caller's point of view.
      if (isUniqueViolation(err)) {
        return null;
      }
      throw err;
    }
  }

  async deactivateActive(namespace: string, key: string, tx?: unknown): Promise<number> {
    const { count } = await this.client(tx).platformConfig.updateMany({
      where: { namespace, key, isActive: true },
      data: { isActive: false },
    });
    return count;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function toProps(row: PrismaPlatformConfig): PlatformConfigProps {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    // The column is `Json`, so this is the typed value exactly as it was validated and stored —
    // an integer comes back an integer and a boolean a boolean, which is the point of the column
    // type. `ConfigValue.rehydrate` is what re-attaches the declared type when one is needed.
    value: row.value as ConfigPrimitive,
    valueType: row.valueType,
    version: row.version,
    isActive: row.isActive,
    reason: row.reason,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
  };
}
