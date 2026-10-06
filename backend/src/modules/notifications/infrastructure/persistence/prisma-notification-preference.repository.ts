import { Injectable } from '@nestjs/common';
import { ChannelPreference as PrismaChannelPreference } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { DigestFrequency, NotificationCategory, NotificationChannel } from '../../domain/enums';
import {
  ChannelPreferenceChange,
  INotificationPreferenceRepository,
  StoredChannelPreference,
} from '../../domain/repositories/notification-preference.repository';

type Category = PrismaChannelPreference['category'];
type Channel = PrismaChannelPreference['channel'];
type Digest = PrismaChannelPreference['digestFrequency'];

function toStored(row: PrismaChannelPreference): StoredChannelPreference {
  return {
    category: row.category as unknown as NotificationCategory,
    channel: row.channel as unknown as NotificationChannel,
    enabled: row.enabled,
    digestFrequency: row.digestFrequency as unknown as DigestFrequency,
  };
}

/**
 * `INotificationPreferenceRepository` over Prisma, on Module 13's own `channel_preferences` table —
 * the one authority for notification preferences. Module 02's `notification_preferences` is not
 * read or written here (or anywhere).
 */
@Injectable()
export class PrismaNotificationPreferenceRepository implements INotificationPreferenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string, category?: NotificationCategory): Promise<StoredChannelPreference[]> {
    const rows = await this.prisma.channelPreference.findMany({
      where: { userId, ...(category ? { category: category as unknown as Category } : {}) },
    });
    return rows.map(toStored);
  }

  async upsert(userId: string, category: NotificationCategory, changes: ChannelPreferenceChange[]): Promise<void> {
    // Each upsert keys on the unique (userId, category, channel) index and carries no nested
    // writes, so Prisma issues a native `INSERT … ON CONFLICT DO UPDATE`: two concurrent first
    // writes of the same preference both succeed, and the last one wins.
    await this.prisma.$transaction(
      changes.map((c) => {
        const key = { userId, category: category as unknown as Category, channel: c.channel as unknown as Channel };
        const digest = c.digestFrequency ? { digestFrequency: c.digestFrequency as unknown as Digest } : {};
        return this.prisma.channelPreference.upsert({
          where: { userId_category_channel: key },
          create: { ...key, enabled: c.enabled, ...digest },
          update: { enabled: c.enabled, ...digest },
        });
      }),
    );
  }
}
