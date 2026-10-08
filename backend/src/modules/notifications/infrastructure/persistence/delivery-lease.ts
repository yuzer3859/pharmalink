import { NotificationDeliveryJob as PrismaJob, Prisma } from '@prisma/client';
import { DeliveryJobStatus } from '../../domain/enums';

/**
 * A `PROCESSING` job whose lease has lapsed at `now` — the worker that claimed it is presumed dead,
 * and the dispatcher may claim it again (Work 13). The one definition, used both by the
 * dispatcher's due-job query and by the queue health snapshot's "stale processing" count
 * (module-16 Work 22), so the two can never disagree.
 */
export const lapsedLeaseWhere = (now: Date): Prisma.NotificationDeliveryJobWhereInput => ({
  status: DeliveryJobStatus.PROCESSING as unknown as PrismaJob['status'],
  leaseExpiresAt: { lte: now },
});
