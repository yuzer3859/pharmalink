import { Injectable } from '@nestjs/common';
import { DeviceToken as PrismaDeviceToken } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  ActiveDeviceToken,
  DevicePlatform,
  DeviceTokenView,
  IDeviceTokenRepository,
} from '../../domain/repositories/device-token.repository';

const SUFFIX_LENGTH = 6;

function toView(row: PrismaDeviceToken): DeviceTokenView {
  return {
    id: row.id,
    platform: row.platform,
    tokenSuffix: row.token.slice(-SUFFIX_LENGTH),
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

/** `IDeviceTokenRepository` over Prisma, on Module 13's own `device_tokens` table. */
@Injectable()
export class PrismaDeviceTokenRepository implements IDeviceTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async register(userId: string, token: string, platform: DevicePlatform, now: Date): Promise<DeviceTokenView> {
    // Keyed on the unique `token`, no nested writes: Prisma issues a native ON CONFLICT DO UPDATE,
    // so concurrent registrations of one token converge on one row.
    const row = await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform, isActive: true, lastSeenAt: now },
      update: { userId, platform, isActive: true, lastSeenAt: now },
    });
    return toView(row);
  }

  async listActiveForUser(userId: string): Promise<DeviceTokenView[]> {
    const rows = await this.prisma.deviceToken.findMany({
      where: { userId, isActive: true },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toView);
  }

  async deactivateForUser(id: string, userId: string): Promise<boolean> {
    const { count } = await this.prisma.deviceToken.updateMany({ where: { id, userId }, data: { isActive: false } });
    return count === 1;
  }

  async activeTokensForDelivery(userId: string, limit: number): Promise<ActiveDeviceToken[]> {
    return this.prisma.deviceToken.findMany({
      where: { userId, isActive: true },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, token: true },
    });
  }

  async deactivateByIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.deviceToken.updateMany({ where: { id: { in: [...ids] } }, data: { isActive: false } });
  }
}
