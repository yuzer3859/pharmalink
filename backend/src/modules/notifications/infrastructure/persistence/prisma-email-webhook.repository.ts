import { Injectable } from '@nestjs/common';
import { DeliveryAttempt as PrismaDeliveryAttempt } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { NotificationChannel, NotificationStatus } from '../../domain/enums';
import {
  EmailAttemptRef,
  IDestinationSuppressionRepository,
  IEmailWebhookRepository,
  WebhookEffect,
} from '../../domain/repositories/email-webhook.repository';

type Channel = PrismaDeliveryAttempt['channel'];
type Status = PrismaDeliveryAttempt['status'];
const EMAIL = NotificationChannel.EMAIL as unknown as Channel;
const SENT = NotificationStatus.SENT as unknown as Status;

/**
 * `IEmailWebhookRepository` over Prisma, on Module 13's own tables. The receipt insert is
 * `ON CONFLICT DO NOTHING` inside the transaction: a concurrent copy of the same event waits on the
 * unique index until the first commits, then inserts nothing and applies nothing.
 */
@Injectable()
export class PrismaEmailWebhookRepository implements IEmailWebhookRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findEmailAttempt(providerMessageId: string): Promise<EmailAttemptRef | null> {
    const row = await this.prisma.deliveryAttempt.findFirst({
      where: { channel: EMAIL, status: SENT, providerMsgId: providerMessageId },
      orderBy: { attemptNumber: 'asc' },
      select: { notificationId: true, attemptNumber: true, provider: true, providerMsgId: true },
    });
    return row && row.providerMsgId
      ? { notificationId: row.notificationId, attemptNumber: row.attemptNumber, provider: row.provider, providerMessageId: row.providerMsgId }
      : null;
  }

  async applyOnce(receipt: { provider: string; eventId: string; eventType: string }, effect: WebhookEffect): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.notificationWebhookReceipt.createMany({ data: [receipt], skipDuplicates: true });
      if (count !== 1) return false;

      const r = effect.receiptAttempt;
      if (r) {
        const already = await tx.deliveryAttempt.findFirst({
          where: {
            notificationId: r.ref.notificationId,
            channel: EMAIL,
            providerMsgId: r.ref.providerMessageId,
            status: r.status as unknown as Status,
            errorCode: r.errorCode,
          },
          select: { id: true },
        });
        if (!already) {
          await tx.deliveryAttempt.create({
            data: {
              notificationId: r.ref.notificationId,
              attemptNumber: r.ref.attemptNumber,
              channel: EMAIL,
              provider: r.ref.provider,
              providerMsgId: r.ref.providerMessageId,
              status: r.status as unknown as Status,
              errorCode: r.errorCode,
              errorDetail: null,
              attemptedAt: r.occurredAt,
            },
          });
        }
      }
      if (effect.suppress && effect.suppress.keys.length > 0) {
        await tx.suppressionEntry.createMany({
          data: effect.suppress.keys.map((address) => ({
            channel: effect.suppress!.channel as unknown as Channel,
            address,
            reason: effect.suppress!.reason,
          })),
          skipDuplicates: true,
        });
      }
      return true;
    });
  }
}

/** `IDestinationSuppressionRepository` over Prisma — one unique-key lookup. */
@Injectable()
export class PrismaDestinationSuppressionRepository implements IDestinationSuppressionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async isSuppressed(channel: NotificationChannel, key: string): Promise<boolean> {
    const row = await this.prisma.suppressionEntry.findUnique({
      where: { channel_address: { channel: channel as unknown as Channel, address: key } },
      select: { id: true },
    });
    return row !== null;
  }
}
