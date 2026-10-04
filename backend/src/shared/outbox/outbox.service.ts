import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DomainEvent } from '../events/domain-event';

/** Minimal client surface needed to write the outbox — satisfied by both PrismaService and a
 * Prisma interactive-transaction client, so producers can enlist the write in their own tx. */
export type OutboxCapableClient = Pick<Prisma.TransactionClient, 'outbox'>;

/**
 * Writes domain events to the `outbox` table in the SAME transaction as the state change that
 * produced them (see ADR-010). Never publishes directly — the OutboxRelay does that. The full
 * event envelope is stored in `payload` so consumers see the original id/occurredAt.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async write<T>(event: DomainEvent<T>, client?: OutboxCapableClient): Promise<void> {
    const db = client ?? this.prisma;
    await db.outbox.create({
      data: {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.type,
        payload: event as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async writeMany<T>(events: DomainEvent<T>[], client?: OutboxCapableClient): Promise<void> {
    for (const event of events) {
      await this.write(event, client);
    }
  }
}
