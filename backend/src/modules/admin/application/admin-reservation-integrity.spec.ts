import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { IReservationIntegrityReadPort } from '../../pharmacy-inventory/application/ports/inbound/reservation-integrity-read.port';
import {
  classifiedListings,
  contributingReservation,
  PrismaReservationIntegrityReadAdapter,
} from '../../pharmacy-inventory/infrastructure/persistence/prisma-reservation-integrity-read.adapter';
import { AdminReservationIntegrityController } from '../interface/controllers/admin-reservation-integrity.controller';
import { ListReservationIntegrityQueryDto, ReservationIntegrityScopeDto } from '../interface/dtos/reservation-integrity.dto';
import {
  toReservationIntegrityListResponse,
  toReservationIntegritySummaryResponse,
} from '../interface/dtos/reservation-integrity.response';
import { GetReservationIntegritySummaryQuery, ListReservationIntegrityQuery, MAX_INTEGRITY_PAGE_SIZE } from './queries/reservation-integrity.queries';

const P1 = '11111111-1111-4111-8111-111111111111';
const B1 = '22222222-2222-4222-8222-222222222222';
const ROW_KEYS = ['listingId', 'pharmacyId', 'branchId', 'catalogProductId', 'storedReserved', 'reservationDerivedReserved', 'difference', 'contributingReservations'];
const src = (f: string) => readFileSync(join(__dirname, '..', '..', 'pharmacy-inventory', f), 'utf8');
/** Collapses whitespace and placeholder numbers so SQL can be compared by shape. */
const shape = (sql: Prisma.Sql) => sql.sql.replace(/\$\d+|\?/g, '$').replace(/\s+/g, ' ').trim();

/** Records each `$queryRaw` tagged call and answers from a queue; `$transaction` records its options. */
function fakePrisma(answers: unknown[][]) {
  const statements: Prisma.Sql[] = [];
  let options: unknown;
  let inTransaction = false;
  const prisma = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(Prisma.sql(strings, ...values));
      return Promise.resolve(answers.shift());
    },
    $transaction: async (ops: Array<Promise<unknown>>, o: unknown) => {
      inTransaction = true;
      options = o;
      return Promise.all(ops);
    },
  } as unknown as PrismaService;
  return { prisma, statements, options: () => options, inTransaction: () => inTransaction };
}

describe('Admin inventory reservation consistency diagnostics (Work 54)', () => {
  describe('the invariant, from Module 04’s writers of inventory_listings.reserved', () => {
    it('reserve +q (creating HELD); release −q; expiry −q (HELD→EXPIRED); dispatch −q for CONFIRMED without changing status; confirm leaves it', () => {
      const reserve = src('application/commands/reserve-stock.command.ts');
      expect(reserve).toMatch(/reserved: listingProps\.reserved \+ input\.quantity/);
      expect(src('infrastructure/persistence/prisma-reservation.repository.ts')).toMatch(/status: ReservationStatus\.HELD/);
      const release = src('application/commands/release-reservation.command.ts');
      expect(release).toMatch(/const newReserved = listingProps\.reserved - reservation\.quantity/);
      expect(release).toMatch(/updateStatus\(input\.reservationId, targetStatus/);
      const expiry = src('application/services/lapsed-hold-expiry.ts');
      expect(expiry).toMatch(/const newReserved = listingProps\.reserved - reservation\.quantity/);
      expect(expiry).toMatch(/updateStatus\(reservation\.id, ReservationStatus\.EXPIRED/);
      const dispatch = src('application/commands/dispatch-stock.command.ts');
      expect(dispatch).toMatch(/reservation\.status !== ReservationStatus\.CONFIRMED/);
      expect(dispatch).toMatch(/const newReserved = listingProps\.reserved - reservation\.quantity/);
      expect(dispatch).toMatch(/type: StockMovementType\.DISPATCH,[\s\S]*reservationId: reservation\.id/);
      expect(dispatch).not.toMatch(/updateStatus\(/);
      // Confirm (HELD → CONFIRMED) never touches the counter: no listing cache write in its source.
      expect(src('application/commands/confirm-reservation.command.ts')).not.toMatch(/updateCache\(/);
      // Batch commands only read it; create-listing starts it at 0.
      expect(src('application/commands/add-batch.command.ts')).not.toMatch(/reserved:/);
      expect(src('application/commands/adjust-batch.command.ts')).not.toMatch(/reserved:/);
      expect(src('application/commands/create-listing.command.ts')).toMatch(/reserved: 0/);
    });

    it('dispatched = dispatch’s own guard (a DISPATCH movement with this reservationId); contributing = HELD, or CONFIRMED and not dispatched', () => {
      expect(src('infrastructure/persistence/prisma-reservation.repository.ts')).toMatch(/where: \{ type: StockMovementType\.DISPATCH, reservationId \}/);
      expect(shape(contributingReservation)).toBe(
        `(r."status" = 'HELD' OR (r."status" = 'CONFIRMED' AND NOT EXISTS (SELECT 1 FROM "stock_movements" m WHERE m."reservationId" = r."id" AND m."type" = 'DISPATCH')))`,
      );
      // RELEASED and EXPIRED never appear as contributing; no expiresAt test (a lapsed HELD still counts until its expiry commits).
      expect(contributingReservation.sql).not.toMatch(/RELEASED|EXPIRED|expiresAt/);
    });

    it('legacy: reservationId on movements is nullable for pre-existing rows, so such a DISPATCH makes the listing undetermined, not consistent', () => {
      const migration = readFileSync(join(__dirname, '..', '..', '..', '..', 'prisma', 'schema', 'migrations', '20260827000000_stock_movement_reservation_id', 'migration.sql'), 'utf8');
      expect(migration).toMatch(/nullable for backfill safety against pre-existing rows/);
      const sql = shape(classifiedListings({}));
      expect(sql).toContain(`r."status" = 'CONFIRMED' AND NOT EXISTS (SELECT 1 FROM "stock_movements" m WHERE m."reservationId" = r."id" AND m."type" = 'DISPATCH')`);
      expect(sql).toContain(`lm."listingId" = r."listingId" AND lm."type" = 'DISPATCH' AND lm."reservationId" IS NULL`);
    });

    it('population: live listings only (Work 49’s deletedAt IS NULL) — Module 04’s listing lock ignores soft-deleted listings', () => {
      expect(src('infrastructure/persistence/prisma-listing.repository.ts')).toMatch(/WHERE "id" = \$\{id\} AND "deletedAt" IS NULL FOR UPDATE/);
      expect(shape(classifiedListings({}))).toContain(`FROM "inventory_listings" il WHERE il."deletedAt" IS NULL`);
      const scoped = classifiedListings({ pharmacyId: P1, branchId: B1 });
      expect(shape(scoped)).toContain(`WHERE il."deletedAt" IS NULL AND il."pharmacyId" = $ AND il."branchId" = $`);
      expect(scoped.values).toEqual([P1, B1]);
    });
  });

  describe('database-side classification', () => {
    it('reservations are aggregated per listing before the join (no batch join; movement checks are EXISTS) and every live listing is kept (LEFT JOIN, COALESCE 0)', () => {
      const sql = shape(classifiedListings({}));
      expect(sql).toContain(`SELECT r."listingId", SUM(r."quantity")::int AS "derived", COUNT(*)::int AS "n" FROM "stock_reservations" r JOIN live ON live."id" = r."listingId"`);
      expect(sql).toContain('GROUP BY r."listingId"');
      expect(sql).toContain('FROM live LEFT JOIN contrib c ON c."listingId" = live."id" LEFT JOIN undetermined u ON u."listingId" = live."id"');
      expect(sql).toContain('COALESCE(c."derived", 0) AS "derived"');
      expect(sql).not.toMatch(/stock_batches|JOIN "stock_movements"/);
    });

    it('list: discrepancies filtered in SQL, largest |difference| then id, bounded page; page and total in one REPEATABLE READ transaction', async () => {
      const f = fakePrisma([
        [
          { id: 'L2', pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp', storedReserved: 1, derived: 5, n: 2 },
          { id: 'L1', pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp', storedReserved: 7, derived: 4, n: 1 },
        ],
        [{ count: BigInt(2) }],
      ]);
      const page = await new PrismaReservationIntegrityReadAdapter(f.prisma).listDiscrepancies({}, 3, 10);
      expect(f.inTransaction()).toBe(true);
      expect(f.options()).toEqual({ isolationLevel: 'RepeatableRead' });
      const [rows, count] = f.statements.map(shape);
      expect(rows).toMatch(/FROM classified WHERE NOT "undetermined" AND "storedReserved" <> "derived" ORDER BY ABS\("storedReserved" - "derived"\) DESC, "id" ASC LIMIT \$ OFFSET \$$/);
      expect(f.statements[0].values.slice(-2)).toEqual([10, 20]);
      expect(count).toMatch(/SELECT COUNT\(\*\) AS "count" FROM classified WHERE NOT "undetermined" AND "storedReserved" <> "derived"$/);
      expect(page.items).toEqual([
        { listingId: 'L2', pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp', storedReserved: 1, reservationDerivedReserved: 5, difference: -4, contributingReservations: 2 },
        { listingId: 'L1', pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp', storedReserved: 7, reservationDerivedReserved: 4, difference: 3, contributingReservations: 1 },
      ]);
      expect([page.total, page.page, page.size]).toEqual([2, 3, 10]);
    });

    it('summary: the three classes over the same population, one statement in one REPEATABLE READ transaction; an empty population is all zeros', async () => {
      const f = fakePrisma([[{ checked: BigInt(5), consistent: BigInt(3), discrepant: BigInt(1), undetermined: BigInt(1) }]]);
      const s = await new PrismaReservationIntegrityReadAdapter(f.prisma).getSummary({ branchId: B1 });
      expect(f.options()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(f.statements).toHaveLength(1);
      const sql = shape(f.statements[0]);
      expect(sql).toContain(`COUNT(*) FILTER (WHERE NOT "undetermined" AND "storedReserved" = "derived") AS "consistent"`);
      expect(sql).toContain(`COUNT(*) FILTER (WHERE NOT "undetermined" AND "storedReserved" <> "derived") AS "discrepant"`);
      expect(sql).toContain(`COUNT(*) FILTER (WHERE "undetermined") AS "undetermined" FROM classified`);
      expect(f.statements[0].values).toEqual([B1]);
      expect(s).toMatchObject({ listingsChecked: 5, listingsConsistent: 3, listingsWithDiscrepancy: 1, listingsUndetermined: 1 });

      const empty = await new PrismaReservationIntegrityReadAdapter(fakePrisma([[{ checked: BigInt(0), consistent: BigInt(0), discrepant: BigInt(0), undetermined: BigInt(0) }]]).prisma).getSummary({});
      expect(empty).toMatchObject({ listingsChecked: 0, listingsConsistent: 0, listingsWithDiscrepancy: 0, listingsUndetermined: 0 });
    });
  });

  describe('Module 16 surface', () => {
    const port = () => {
      const calls: unknown[][] = [];
      const p: IReservationIntegrityReadPort = {
        listDiscrepancies: async (...a) => (calls.push(['list', ...a]), { generatedAt: new Date(0), items: [], total: 0, page: a[1], size: a[2] }),
        getSummary: async (...a) => (calls.push(['summary', ...a]), { generatedAt: new Date(0), listingsChecked: 0, listingsConsistent: 0, listingsWithDiscrepancy: 0, listingsUndetermined: 0 }),
      };
      return { p, calls };
    };

    it('paging defaults to 1/20 and clamps to 100; only the owner scope is forwarded', async () => {
      const { p, calls } = port();
      await new ListReservationIntegrityQuery(p).execute({});
      await new ListReservationIntegrityQuery(p).execute({ page: 2, size: 500, pharmacyId: P1, branchId: B1 });
      await new GetReservationIntegritySummaryQuery(p).execute({ pharmacyId: P1 });
      expect(calls).toEqual([
        ['list', { pharmacyId: undefined, branchId: undefined }, 1, 20],
        ['list', { pharmacyId: P1, branchId: B1 }, 2, MAX_INTEGRITY_PAGE_SIZE],
        ['summary', { pharmacyId: P1, branchId: undefined }],
      ]);
    });

    it('request validation: UUID scope, bounded paging; nothing else accepted (no listing/reservation/order filter)', () => {
      const errors = (cls: new () => object, plain: object) =>
        validateSync(plainToInstance(cls, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);
      expect(errors(ListReservationIntegrityQueryDto, { pharmacyId: P1, branchId: B1, page: '2', size: '100' })).toEqual([]);
      expect(errors(ListReservationIntegrityQueryDto, { pharmacyId: 'x', page: '0', size: '101' }).sort()).toEqual(['page', 'pharmacyId', 'size']);
      for (const extra of ['listingId', 'reservationId', 'orderId', 'status', 'repair']) {
        expect(errors(ListReservationIntegrityQueryDto, { [extra]: P1 })).toEqual([extra]);
        expect(errors(ReservationIntegrityScopeDto, { [extra]: P1 })).toEqual([extra]);
      }
      expect(errors(ReservationIntegrityScopeDto, { page: '1' })).toEqual(['page']);
    });

    it('explicit allow-lists: listing-level quantities only, extra port fields never reach the response', () => {
      const leaky = { listingId: 'L', pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp', storedReserved: 2, reservationDerivedReserved: 1, difference: 1, contributingReservations: 1, orderId: 'o', reservationIds: ['r'], ownerUserId: 'u' };
      const list = toReservationIntegrityListResponse({ generatedAt: new Date(0), items: [leaky], total: 1, page: 1, size: 20 });
      expect(Object.keys(list)).toEqual(['generatedAt', 'items', 'total', 'page', 'size']);
      expect(Object.keys(list.items[0])).toEqual(ROW_KEYS);
      const summary = toReservationIntegritySummaryResponse({ generatedAt: new Date(0), listingsChecked: 1, listingsConsistent: 1, listingsWithDiscrepancy: 0, listingsUndetermined: 0, extra: 1 } as never);
      expect(Object.keys(summary)).toEqual(['generatedAt', 'listingsChecked', 'listingsConsistent', 'listingsWithDiscrepancy', 'listingsUndetermined']);
    });

    it('pharmacy:read:any (Works 47–52), GET-only, static paths; ADMIN and SUPER_ADMIN only', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminReservationIntegrityController)).toEqual(['pharmacy:read:any']);
      expect(Reflect.getMetadata('path', AdminReservationIntegrityController)).toBe('admin/operations/inventory/reservation-integrity');
      const proto = AdminReservationIntegrityController.prototype as unknown as Record<string, () => unknown>;
      const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor');
      expect(methods.map((m) => [m, Reflect.getMetadata('path', proto[m]), Reflect.getMetadata('method', proto[m])])).toEqual([
        ['discrepancies', '/', 0],
        ['totals', 'summary', 0],
      ]);
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'pharmacy:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
    });
  });
});
