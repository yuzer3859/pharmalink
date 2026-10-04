import { Injectable } from '@nestjs/common';
import { Prisma, ProviderWebhook as PrismaProviderWebhook } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IWebhookRepository,
  NewProviderWebhookData,
  ProviderWebhookSnapshot,
} from '../../domain/repositories/webhook.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toSnapshot(row: PrismaProviderWebhook): ProviderWebhookSnapshot {
  return {
    id: row.id,
    provider: row.provider,
    eventId: row.eventId,
    payload: row.payload,
    processedAt: row.processedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Prisma adapter for `IWebhookRepository` (§7 `provider_webhooks`). Follows the same
 * `tx?: unknown` pass-through convention as every other Module 04/05/06/07 repository adapter —
 * it never opens its own transaction; the caller's `IUnitOfWork` owns that boundary, which is
 * what lets `ProcessWebhookCommand` commit the dedup claim and the business effects together.
 *
 * `payload` is the only column here that holds provider-shaped data, and this adapter is the only
 * place it is written. It is never projected into a domain type — `ProviderWebhookSnapshot.payload`
 * is typed `unknown` precisely so nothing downstream can reach into it casually.
 */
@Injectable()
export class PrismaWebhookRepository implements IWebhookRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findByProviderEvent(
    provider: string,
    eventId: string,
    tx?: unknown,
  ): Promise<ProviderWebhookSnapshot | null> {
    const row = await this.client(tx).providerWebhook.findUnique({
      where: { provider_eventId: { provider, eventId } },
    });
    return row ? toSnapshot(row) : null;
  }

  async record(
    data: NewProviderWebhookData,
    tx?: unknown,
  ): Promise<ProviderWebhookSnapshot> {
    const row = await this.client(tx).providerWebhook.create({
      data: {
        provider: data.provider,
        eventId: data.eventId,
        // `provider_webhooks.payload` is a NOT NULL Json column, so an absent payload is stored
        // as the JSON literal `null` (`Prisma.JsonNull`), not as SQL NULL — which the column
        // would reject anyway.
        payload:
          data.payload === null || data.payload === undefined
            ? Prisma.JsonNull
            : (data.payload as Prisma.InputJsonValue),
        processedAt: data.processedAt ?? null,
      },
    });
    return toSnapshot(row);
  }

  async markProcessed(id: string, processedAt: Date, tx?: unknown): Promise<void> {
    await this.client(tx).providerWebhook.update({ where: { id }, data: { processedAt } });
  }

  async findUnprocessed(limit: number, tx?: unknown): Promise<ProviderWebhookSnapshot[]> {
    const rows = await this.client(tx).providerWebhook.findMany({
      where: { processedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toSnapshot);
  }
}
