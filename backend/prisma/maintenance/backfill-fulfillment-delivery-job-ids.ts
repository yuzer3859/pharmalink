import { Prisma, PrismaClient } from '@prisma/client';

/**
 * One-off **and** recovery data repair: records each Module 08 delivery job's id on the Module 06
 * fulfillment it was cut for (`fulfillments.deliveryJobId`), where that reference is missing.
 *
 *     npm run maintenance:backfill-delivery-job-refs
 *
 * ## Why a maintenance script and not a migration
 *
 * It reads `delivery_jobs` (Module 08) to write `fulfillments` (Module 06). Inside a module that
 * would be a cross-context query; as a migration it would run once and never again — but it is
 * also the recovery path for `DeliveryJobCreatedHandler`, whose failures nothing retries
 * (`EventBusService` isolates a throwing handler and `OutboxRelay` marks the event published
 * anyway). So it lives beside `seed.ts`, outside every module, and is safe to run any number of
 * times.
 *
 * ## What it touches
 *
 * Only `fulfillments.deliveryJobId`, only where it is NULL, only from a job whose `fulfillmentId`
 * is that fulfillment **and** whose `orderId` is the fulfillment's own order, and only when that
 * fulfillment has exactly one job (`delivery_jobs.fulfillmentId` is unique, so more than one would
 * be corruption — reported as ambiguous and left alone). A reference that already names a
 * different job is never overwritten. Nothing else on any row changes; no audit entry, no event.
 *
 * It prints counts only — no id, no personal data.
 */
export interface DeliveryJobReferenceBackfillReport {
  /** References written by this run. */
  populated: number;
  /** Fulfillments already naming their job. */
  alreadyCorrect: number;
  /** Fulfillments naming a different job than the one cut for them — left as they are. */
  conflicting: number;
  /** Jobs whose `orderId` is not the fulfillment's order — left alone. */
  orderMismatch: number;
  /** Jobs whose `fulfillmentId` matches no fulfillment. */
  orphaned: number;
  /** Fulfillments with more than one job — never resolved by picking one. */
  ambiguous: number;
}

type Db = Pick<PrismaClient, '$transaction'>;

export async function backfillFulfillmentDeliveryJobIds(prisma: Db): Promise<DeliveryJobReferenceBackfillReport> {
  return prisma.$transaction(
    async (tx) => {
      const [before] = await tx.$queryRaw<
        Array<{ alreadyCorrect: bigint; conflicting: bigint; orderMismatch: bigint; orphaned: bigint; ambiguous: bigint }>
      >`
        WITH single AS (
          SELECT j."id", j."fulfillmentId", j."orderId"
            FROM "delivery_jobs" j
           WHERE (SELECT COUNT(*) FROM "delivery_jobs" k WHERE k."fulfillmentId" = j."fulfillmentId") = 1
        )
        SELECT
          COUNT(*) FILTER (WHERE f."id" IS NOT NULL AND f."orderId" = s."orderId" AND f."deliveryJobId" = s."id")::bigint AS "alreadyCorrect",
          COUNT(*) FILTER (WHERE f."id" IS NOT NULL AND f."orderId" = s."orderId" AND f."deliveryJobId" IS NOT NULL AND f."deliveryJobId" <> s."id")::bigint AS "conflicting",
          COUNT(*) FILTER (WHERE f."id" IS NOT NULL AND f."orderId" <> s."orderId")::bigint AS "orderMismatch",
          COUNT(*) FILTER (WHERE f."id" IS NULL)::bigint AS "orphaned",
          (SELECT COUNT(*) FROM (SELECT 1 FROM "delivery_jobs" GROUP BY "fulfillmentId" HAVING COUNT(*) > 1) a)::bigint AS "ambiguous"
        FROM single s
        LEFT JOIN "fulfillments" f ON f."id" = s."fulfillmentId"
      `;
      const populated = await tx.$executeRaw`
        UPDATE "fulfillments" f
           SET "deliveryJobId" = j."id"
          FROM "delivery_jobs" j
         WHERE j."fulfillmentId" = f."id"
           AND j."orderId" = f."orderId"
           AND f."deliveryJobId" IS NULL
           AND NOT EXISTS (SELECT 1 FROM "delivery_jobs" k WHERE k."fulfillmentId" = j."fulfillmentId" AND k."id" <> j."id")
      `;
      return {
        populated,
        alreadyCorrect: Number(before.alreadyCorrect),
        conflicting: Number(before.conflicting),
        orderMismatch: Number(before.orderMismatch),
        orphaned: Number(before.orphaned),
        ambiguous: Number(before.ambiguous),
      };
    },
    // The counts and the guarded UPDATE see one snapshot; a concurrent link by the event handler
    // makes the UPDATE skip that row (its `IS NULL` guard) rather than overwrite it.
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const report = await backfillFulfillmentDeliveryJobIds(prisma);
    console.log(JSON.stringify({ task: 'backfill-fulfillment-delivery-job-ids', ...report }));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
