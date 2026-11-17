import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { RxRequestCommands } from '../../application/commands/rx-request.commands';
import { IRxRequestRepository, RX_REQUEST_REPOSITORY } from '../../domain/repositories/rx-request.repository';

export const RX_REQUEST_EXPIRY_CRON = 'orders.rx-request-expiry';

/** At most this many requests per tick; the rest wait for the next minute. */
const BATCH = 100;

/**
 * Work 134: every minute, settles the prescription requests whose time ran out:
 *
 * - an offer window that ended with nobody accepting (`rxRequests.offerMinutes`) ends the request
 *   `EXPIRED`, telling the customer and the pharmacies still considering it;
 * - an acceptance not quoted in time (`rxRequests.claimMinutes`) lets the request go: it is offered
 *   to the other pharmacies again and that pharmacy's offer is `LAPSED`.
 *
 * The deadlines are columns, so a restarted process reaches the same decisions. Each request is
 * locked with `FOR UPDATE SKIP LOCKED` in its own transaction, so two instances take different
 * rows, and every change is a compare-and-set, so a pharmacy's answer that lands first wins and the
 * sweep of that row becomes a no-op. Never throws: one bad row is logged and skipped.
 */
@Injectable()
export class RxRequestExpirySweeper {
  private readonly logger = new AppLogger();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RX_REQUEST_REPOSITORY) private readonly requests: IRxRequestRepository,
    private readonly commands: RxRequestCommands,
  ) {
    this.logger.setContext(RxRequestExpirySweeper.name);
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: RX_REQUEST_EXPIRY_CRON })
  async run(now = new Date()): Promise<number> {
    const skipped: string[] = [];
    let settled = 0;
    for (let i = 0; i < BATCH; i += 1) {
      let lockedId: string | null = null;
      try {
        const done = await this.prisma.$transaction(
          async (tx) => {
            const due = await this.requests.lockNextDue(now, skipped, tx);
            if (!due) return null;
            lockedId = due.id;
            await this.commands.settleDue(due, now, tx);
            return due.id;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        );
        if (!done) break;
        // A request settled once is no longer due; skipping it guards against a row that stays due.
        skipped.push(done);
        settled += 1;
      } catch (err) {
        this.logger.error(`Failed to settle prescription request ${lockedId ?? '(unknown)'}: ${err instanceof Error ? err.message : String(err)}`);
        if (!lockedId) break;
        skipped.push(lockedId);
      }
    }
    if (settled > 0) this.logger.log(`Settled ${settled} prescription request(s) past their deadline.`);
    return settled;
  }
}
