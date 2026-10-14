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
 * would be a cross-context query; as a migration it would run once and never again. So it lives
 * beside `seed.ts`, outside every module, and is safe to run any number of times.
 *
 * ## Its role beside the runtime reconciler (Work 45)
 *
 * `DeliveryJobCreatedHandler`'s failures are not retried by the event bus, so missed references are
 * now recovered automatically by Module 06's `DeliveryJobReferenceReconciler` — a bounded batch every
 * five minutes, through Module 08's read port and the same rule (`linkDeliveryJobReference`). This
 * script stays the operator's tool for doing the whole table at once (after a deploy, or to confirm
 * the counts), applying the same rules set-based: fill only a NULL reference, only from the job cut
 * for that fulfillment and order, never choose among several jobs, never overwrite.
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
    // READ COMMITTED, deliberately (Work 45). The guarded UPDATE runs concurrently with the event
    // handler and the runtime reconciler; when one of them fills a row first, Postgres re-checks
    // `deliveryJobId IS NULL` against the committed row and skips it. Under REPEATABLE READ the same
    // race aborts the whole run with a serialization failure (40001) instead. The counts are therefore
    // statement-level, and `populated` is the UPDATE's own row count.
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
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
