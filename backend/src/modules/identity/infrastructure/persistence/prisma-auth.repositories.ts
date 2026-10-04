import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { DevicePlatform, LoginOutcome } from '../../domain/enums';
import {
  DeviceInfo,
  DeviceRecord,
  IDeviceRepository,
  ILoginHistoryRepository,
  IRefreshTokenRepository,
  ISessionRepository,
  LoginHistoryEntry,
  LoginHistoryRecord,
  NewRefreshToken,
  NewSession,
  PaginatedResult,
  RefreshTokenRecord,
  SessionRecord,
} from '../../domain/repositories/auth.repositories';

type Client = PrismaService | Prisma.TransactionClient;

@Injectable()
export class PrismaRefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: NewRefreshToken, tx?: unknown): Promise<RefreshTokenRecord> {
    const client = (tx as Client) ?? this.prisma;
    const row = await client.refreshToken.create({
      data: {
        userId: data.userId,
        deviceId: data.deviceId,
        tokenHash: data.tokenHash,
        familyId: data.familyId,
        expiresAt: data.expiresAt,
      },
    });
    return row;
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async markUsed(id: string, replacedById: string, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    await client.refreshToken.update({
      where: { id },
      data: { usedAt: new Date(), replacedBy: replacedById },
    });
  }

  async revokeFamily(familyId: string, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    await client.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string, tx?: unknown): Promise<number> {
    const client = (tx as Client) ?? this.prisma;
    const result = await client.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}

@Injectable()
export class PrismaSessionRepository implements ISessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: NewSession, tx?: unknown): Promise<SessionRecord> {
    const client = (tx as Client) ?? this.prisma;
    return client.session.create({
      data: {
        userId: data.userId,
        deviceId: data.deviceId,
        ip: data.ip,
        userAgent: data.userAgent,
        expiresAt: data.expiresAt,
      },
    });
  }

  async findById(id: string): Promise<SessionRecord | null> {
    return this.prisma.session.findUnique({ where: { id } });
  }

  async revoke(id: string): Promise<void> {
    await this.prisma.session.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: string, tx?: unknown): Promise<number> {
    const client = (tx as Client) ?? this.prisma;
    const result = await client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async listActiveForUser(userId: string): Promise<SessionRecord[]> {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }
}

@Injectable()
export class PrismaDeviceRepository implements IDeviceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertForUser(userId: string, info: DeviceInfo): Promise<DeviceRecord> {
    const existing = await this.prisma.device.findFirst({
      where: { userId, fingerprint: info.fingerprint },
    });
    if (existing) {
      const updated = await this.prisma.device.update({
        where: { id: existing.id },
        data: {
          lastLoginAt: new Date(),
          fcmToken: info.fcmToken ?? existing.fcmToken,
          name: info.name ?? existing.name,
        },
      });
      return { ...updated, platform: updated.platform as unknown as DeviceRecord['platform'] };
    }
    const created = await this.prisma.device.create({
      data: {
        userId,
        fingerprint: info.fingerprint,
        name: info.name ?? null,
        platform: info.platform as unknown as DevicePlatform,
        fcmToken: info.fcmToken ?? null,
        lastLoginAt: new Date(),
      },
    });
    return { ...created, platform: created.platform as unknown as DeviceRecord['platform'] };
  }

  async findById(id: string): Promise<DeviceRecord | null> {
    const row = await this.prisma.device.findUnique({ where: { id } });
    return row ? { ...row, platform: row.platform as unknown as DeviceRecord['platform'] } : null;
  }

  async listForUser(userId: string): Promise<DeviceRecord[]> {
    const rows = await this.prisma.device.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      ...row,
      platform: row.platform as unknown as DeviceRecord['platform'],
    }));
  }

  async revoke(id: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.device.update({ where: { id }, data: { revokedAt: new Date() } }),
      this.prisma.refreshToken.updateMany({
        where: { deviceId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.session.updateMany({
        where: { deviceId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }
}

@Injectable()
export class PrismaLoginHistoryRepository implements ILoginHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: LoginHistoryEntry): Promise<void> {
    await this.prisma.loginHistory.create({
      data: {
        userId: entry.userId,
        identifier: entry.identifier,
        deviceId: entry.deviceId,
        ip: entry.ip,
        userAgent: entry.userAgent,
        outcome: entry.outcome as unknown as LoginOutcome,
        failureReason: entry.failureReason ?? null,
      },
    });
  }

  async listForUser(
    userId: string,
    page: number,
    size: number,
  ): Promise<PaginatedResult<LoginHistoryRecord>> {
    const [items, total] = await Promise.all([
      this.prisma.loginHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.loginHistory.count({ where: { userId } }),
    ]);
    return {
      items: items.map((row) => ({ ...row, outcome: row.outcome as unknown as LoginHistoryRecord['outcome'] })),
      total,
      page,
      size,
    };
  }
}
