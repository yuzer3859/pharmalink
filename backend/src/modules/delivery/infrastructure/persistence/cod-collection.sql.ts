import { Prisma } from '@prisma/client';

/**
 * The SQL forms of `toCodReconciliationView`'s two flags, shared by every aggregate over
 * `cod_collections` so a count can never disagree with the item view it summarizes.
 *
 * Both assume the collection is aliased `c` and its (at most one, `collectionId` is unique)
 * remittance is `LEFT JOIN`ed as `r`.
 */

/** `isOutstanding`: the collection has not reached `RECONCILED`, whatever any finding said. */
export const COD_OUTSTANDING_SQL = Prisma.sql`c."status" <> 'RECONCILED'::"CodCollectionStatus"`;

/**
 * `hasDiscrepancy`: the collected amount differs from the expected one, or a remittance exists and
 * its amount differs from the collected one. No remittance is not a remittance variance.
 */
export const COD_DISCREPANCY_SQL = Prisma.sql`(c."collectedAmount" <> c."expectedAmount"
             OR (r."id" IS NOT NULL AND r."remittedAmount" <> c."collectedAmount"))`;
