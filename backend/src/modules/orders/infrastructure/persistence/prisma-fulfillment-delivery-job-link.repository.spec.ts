import { Prisma } from '@prisma/client';
import { backfillFulfillmentDeliveryJobIds } from '../../../../../prisma/maintenance/backfill-fulfillment-delivery-job-ids';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { PrismaFulfillmentDeliveryJobLinkRepository } from './prisma-fulfillment-delivery-job-link.repository';

const FUL = 'f-1';
const ORDER = 'o-1';

/** An in-memory `fulfillments` row behind an atomic compare-and-set, like Postgres's row lock. */
function fakeDb(row: { id: string; orderId: string; deliveryJobId: string | null; status: string } | null) {
  const writes: unknown[] = [];
  const prisma = {
    fulfillment: {
      updateMany: async (args: { where: { id: string; orderId: string; deliveryJobId: null }; data: { deliveryJobId: string } }) => {
        writes.push(args);
        await Promise.resolve(); // yield, so concurrent calls interleave
        if (row && row.id === args.where.id && row.orderId === args.where.orderId && row.deliveryJobId === null) {
          row.deliveryJobId = args.data.deliveryJobId;
          return { count: 1 };
        }
        return { count: 0 };
      },
      findUnique: async () => (row ? { orderId: row.orderId, deliveryJobId: row.deliveryJobId } : null),
    },
  } as unknown as PrismaService;
  return { prisma, writes, row: () => row };
}

describe('PrismaFulfillmentDeliveryJobLinkRepository', () => {
  it('a missing reference is set by ONE guarded update — id, orderId and deliveryJobId IS NULL — writing only deliveryJobId', async () => {
    const db = fakeDb({ id: FUL, orderId: ORDER, deliveryJobId: null, status: 'READY' });
    expect(await new PrismaFulfillmentDeliveryJobLinkRepository(db.prisma).link({ fulfillmentId: FUL, orderId: ORDER, deliveryJobId: 'job-1' })).toBe('LINKED');
    expect(db.writes).toEqual([{ where: { id: FUL, orderId: ORDER, deliveryJobId: null }, data: { deliveryJobId: 'job-1' } }]);
    expect(db.row()).toEqual({ id: FUL, orderId: ORDER, deliveryJobId: 'job-1', status: 'READY' }); // status untouched
  });

  it('redelivery of the same job is ALREADY_LINKED and changes nothing', async () => {
    const db = fakeDb({ id: FUL, orderId: ORDER, deliveryJobId: 'job-1', status: 'READY' });
    expect(await new PrismaFulfillmentDeliveryJobLinkRepository(db.prisma).link({ fulfillmentId: FUL, orderId: ORDER, deliveryJobId: 'job-1' })).toBe('ALREADY_LINKED');
    expect(db.row()!.deliveryJobId).toBe('job-1');
  });

  it('a different existing reference is CONFLICT and is not overwritten', async () => {
    const db = fakeDb({ id: FUL, orderId: ORDER, deliveryJobId: 'job-OLD', status: 'READY' });
    expect(await new PrismaFulfillmentDeliveryJobLinkRepository(db.prisma).link({ fulfillmentId: FUL, orderId: ORDER, deliveryJobId: 'job-NEW' })).toBe('CONFLICT');
    expect(db.row()!.deliveryJobId).toBe('job-OLD');
  });

  it('unknown fulfillment → FULFILLMENT_NOT_FOUND; another order’s fulfillment → ORDER_MISMATCH, untouched', async () => {
    expect(await new PrismaFulfillmentDeliveryJobLinkRepository(fakeDb(null).prisma).link({ fulfillmentId: FUL, orderId: ORDER, deliveryJobId: 'job-1' })).toBe('FULFILLMENT_NOT_FOUND');
    const db = fakeDb({ id: FUL, orderId: 'o-OTHER', deliveryJobId: null, status: 'READY' });
    expect(await new PrismaFulfillmentDeliveryJobLinkRepository(db.prisma).link({ fulfillmentId: FUL, orderId: ORDER, deliveryJobId: 'job-1' })).toBe('ORDER_MISMATCH');
    expect(db.row()!.deliveryJobId).toBeNull();
  });

  it('concurrent duplicate deliveries: exactly one LINKED, the rest ALREADY_LINKED; a racing different job cannot replace it', async () => {
    const db = fakeDb({ id: FUL, orderId: ORDER, deliveryJobId: null, status: 'READY' });
    const repo = new PrismaFulfillmentDeliveryJobLinkRepository(db.prisma);
    const results = await Promise.all([1, 2, 3].map(() => repo.link({ fulfillmentId: FUL, orderId: ORDER, deliveryJobId: 'job-1' })));
    expect(results.sort()).toEqual(['ALREADY_LINKED', 'ALREADY_LINKED', 'LINKED']);
    expect(await repo.link({ fulfillmentId: FUL, orderId: ORDER, deliveryJobId: 'job-2' })).toBe('CONFLICT');
    expect(db.row()!.deliveryJobId).toBe('job-1');
  });
});

describe('backfillFulfillmentDeliveryJobIds (maintenance script)', () => {
  let statements: Prisma.Sql[];
  let isolation: unknown;
  beforeAll(async () => {
    statements = [];
    const tx = {
      $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (statements.push(Prisma.sql(s, ...v)), [{ alreadyCorrect: 2n, conflicting: 1n, orderMismatch: 1n, orphaned: 1n, ambiguous: 0n }]),
      $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (statements.push(Prisma.sql(s, ...v)), 3),
    };
    const prisma = { $transaction: async (fn: (t: unknown) => unknown, o: unknown) => ((isolation = o), fn(tx)) };
    expect(await backfillFulfillmentDeliveryJobIds(prisma as never)).toEqual({ populated: 3, alreadyCorrect: 2, conflicting: 1, orderMismatch: 1, orphaned: 1, ambiguous: 0 });
  });
  const update = () => statements[1].text.replace(/\s+/g, ' ');

  it('counts and update run in one REPEATABLE READ transaction, binding no values', () => {
    expect(isolation).toEqual({ isolationLevel: 'RepeatableRead' });
    expect(statements).toHaveLength(2);
    expect(statements.every((s) => s.values.length === 0)).toBe(true);
  });

  it('only populates missing references: the UPDATE is guarded by deliveryJobId IS NULL, so correct and conflicting ones are never written', () => {
    expect(update()).toContain('UPDATE "fulfillments" f SET "deliveryJobId" = j."id" FROM "delivery_jobs" j');
    expect(update()).toContain('AND f."deliveryJobId" IS NULL');
    expect(update()).not.toMatch(/SET .*,/); // one column
  });

  it('matches through the real relationship — job.fulfillmentId = fulfillment.id AND the same order — and never picks among several jobs', () => {
    expect(update()).toContain('WHERE j."fulfillmentId" = f."id" AND j."orderId" = f."orderId"');
    expect(update()).toContain('NOT EXISTS (SELECT 1 FROM "delivery_jobs" k WHERE k."fulfillmentId" = j."fulfillmentId" AND k."id" <> j."id")');
  });

  it('reports conflicting, order-mismatched, orphaned and ambiguous rows without touching them; rerunning is safe because the guard is the same', () => {
    const counts = statements[0].text.replace(/\s+/g, ' ');
    for (const k of ['alreadyCorrect', 'conflicting', 'orderMismatch', 'orphaned', 'ambiguous']) expect(counts).toContain(`AS "${k}"`);
    expect(counts).toContain('LEFT JOIN "fulfillments" f ON f."id" = s."fulfillmentId"');
  });
});
