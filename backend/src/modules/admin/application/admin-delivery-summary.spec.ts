import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  DeliveryBacklogSummary,
  DeliveryJobStatus,
  IDeliveryBacklogSummaryReadPort,
} from '../../delivery/application/ports/inbound/delivery-backlog-summary-read.port';
import { DeliveryStatusPolicy } from '../../delivery/domain/services/delivery-status-policy';
import {
  PrismaDeliveryBacklogSummaryReadAdapter,
  TERMINAL_DELIVERY_JOB_STATUSES,
} from '../../delivery/infrastructure/persistence/prisma-delivery-backlog-summary-read.adapter';
import { AdminModule } from '../admin.module';
import { AdminDeliveryOperationsController } from '../interface/controllers/admin-delivery-operations.controller';
import { AdminDeliverySummaryController } from '../interface/controllers/admin-delivery-summary.controller';
import { toDeliveryBacklogSummaryResponse } from '../interface/dtos/delivery-backlog-summary.response';
import { GetDeliveryBacklogSummaryQuery } from './queries/get-delivery-backlog-summary.query';

const NOW = new Date('2026-10-13T12:00:00Z');
const STATUSES = Object.values(DeliveryJobStatus);
type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  generatedAt: NOW, byStatus: null, total: 0n, nonTerminalCount: 0n, oldestNonTerminalCreatedAt: null, oldestNonTerminalAgeSeconds: null, unassignedCount: 0n, ...over,
});

function fakePrisma(result: Row) {
  const statements: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => (statements.push(Prisma.sql(strings, ...values)), [result]),
  } as unknown as PrismaService;
  return { prisma, statements };
}

describe('Admin delivery backlog summary (application)', () => {
  describe('terminal classification', () => {
    it('is Module 08’s own: exactly the statuses with no outgoing transition — COMPLETED, CANCELLED, FAILED; DELIVERED and REASSIGNING are not terminal', () => {
      expect([...TERMINAL_DELIVERY_JOB_STATUSES]).toEqual(['COMPLETED', 'CANCELLED', 'FAILED']);
      for (const s of STATUSES) expect({ s, terminal: TERMINAL_DELIVERY_JOB_STATUSES.includes(s) }).toEqual({ s, terminal: DeliveryStatusPolicy.isTerminal(s) });
      expect(STATUSES).toEqual(['CREATED', 'OFFERED', 'ASSIGNED', 'ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_DROPOFF', 'DELIVERED', 'COMPLETED', 'REASSIGNING', 'CANCELLED', 'FAILED']);
    });
  });

  describe('Module 08 adapter — mapping', () => {
    it('empty dataset: zeros, all 12 statuses zero-filled in declaration order, oldest timestamp and age null', async () => {
      const s = await new PrismaDeliveryBacklogSummaryReadAdapter(fakePrisma(row()).prisma).summarizeBacklog();
      expect(s).toEqual({
        generatedAt: NOW,
        jobs: { total: 0, byStatus: Object.fromEntries(STATUSES.map((k) => [k, 0])), nonTerminalCount: 0, oldestNonTerminalCreatedAt: null, oldestNonTerminalAgeSeconds: null },
        assignment: { unassignedCount: 0 },
      });
      expect(Object.keys(s.jobs.byStatus)).toEqual(STATUSES);
    });

    it('mixed counts: stored statuses mapped, missing ones zero-filled; bigints narrowed', async () => {
      const oldest = new Date('2026-10-13T10:00:00Z');
      const s = await new PrismaDeliveryBacklogSummaryReadAdapter(fakePrisma(row({
        byStatus: { CREATED: 2, EN_ROUTE: 1, DELIVERED: 1, COMPLETED: 4, FAILED: 1 }, total: 9n, nonTerminalCount: 4n,
        oldestNonTerminalCreatedAt: oldest, oldestNonTerminalAgeSeconds: 7200n, unassignedCount: 2n,
      })).prisma).summarizeBacklog();
      expect(s.jobs).toEqual({
        total: 9,
        byStatus: { CREATED: 2, OFFERED: 0, ASSIGNED: 0, ARRIVED_PICKUP: 0, PICKED_UP: 0, EN_ROUTE: 1, ARRIVED_DROPOFF: 0, DELIVERED: 1, COMPLETED: 4, REASSIGNING: 0, CANCELLED: 0, FAILED: 1 },
        nonTerminalCount: 4, oldestNonTerminalCreatedAt: oldest, oldestNonTerminalAgeSeconds: 7200,
      });
      expect(s.assignment).toEqual({ unassignedCount: 2 });
    });
  });

  describe('Module 08 adapter — the statement', () => {
    let statement: Prisma.Sql;
    let sql: string;
    beforeAll(async () => {
      const fake = fakePrisma(row());
      await new PrismaDeliveryBacklogSummaryReadAdapter(fake.prisma).summarizeBacklog();
      expect(fake.statements).toHaveLength(1); // one statement: one snapshot, generatedAt from the same clock
      statement = fake.statements[0];
      sql = statement.text.replace(/\s+/g, ' ');
    });

    it('reads delivery_jobs alone — no join that could multiply a job — and generatedAt from now()', () => {
      expect(sql).toContain('now() AS "generatedAt"');
      expect(sql).toMatch(/FROM "delivery_jobs" j\s*$/);
      expect(sql).not.toMatch(/JOIN/i);
    });

    it('non-terminal is "status not in the policy’s terminal set", bound as parameters, applied to the count, the oldest and the unassigned count', () => {
      expect(statement.values.filter((v) => typeof v === 'string')).toEqual(expect.arrayContaining(['COMPLETED', 'CANCELLED', 'FAILED']));
      expect(new Set(statement.values)).toEqual(new Set(['COMPLETED', 'CANCELLED', 'FAILED']));
      expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE j\."status"::text NOT IN \(\$\d+,\$\d+,\$\d+\)\)::bigint AS "nonTerminalCount"/);
      expect(sql).toMatch(/MIN\(j\."createdAt"\) FILTER \(WHERE j\."status"::text NOT IN \(\$\d+,\$\d+,\$\d+\)\) AS "oldestNonTerminalCreatedAt"/);
      expect(sql).toMatch(/NOT IN \(\$\d+,\$\d+,\$\d+\) AND j\."assignedDriverId" IS NULL\)::bigint AS "unassignedCount"/);
    });

    it('age: floored seconds to the same now(), never negative, NULL (not 0) when no job is non-terminal', () => {
      expect(sql).toMatch(/CASE WHEN MIN\(j\."createdAt"\) FILTER \(WHERE .*?\) IS NULL THEN NULL ELSE GREATEST\(0, FLOOR\(EXTRACT\(EPOCH FROM \(now\(\) - MIN\(j\."createdAt"\)/);
    });

    it('no ETA metric: etaAt is not read (nothing in Module 08 writes it)', () => {
      expect(sql).not.toMatch(/etaAt/);
    });
  });

  describe('Module 16 surface', () => {
    it('the query delegates to the port; the response is an explicit allow-list of counts and timestamps', async () => {
      const summary: DeliveryBacklogSummary = {
        generatedAt: NOW,
        jobs: { total: 1, byStatus: Object.fromEntries(STATUSES.map((k) => [k, k === 'CREATED' ? 1 : 0])) as Record<DeliveryJobStatus, number>, nonTerminalCount: 1, oldestNonTerminalCreatedAt: new Date('2026-10-13T11:00:00Z'), oldestNonTerminalAgeSeconds: 3600 },
        assignment: { unassignedCount: 1 },
      };
      Object.assign(summary.jobs, { oldestJobId: 'job-secret', driverId: 'drv-secret' });
      Object.assign(summary, { overdueCount: 7, dropoffAddress: 'Bole secret' });
      const port: IDeliveryBacklogSummaryReadPort = { summarizeBacklog: async () => summary };
      const res = toDeliveryBacklogSummaryResponse(await new GetDeliveryBacklogSummaryQuery(port).execute());
      expect(Object.keys(res)).toEqual(['generatedAt', 'jobs', 'assignment']);
      expect(Object.keys(res.jobs)).toEqual(['total', 'byStatus', 'nonTerminalCount', 'oldestNonTerminalCreatedAt', 'oldestNonTerminalAgeSeconds']);
      expect(res.assignment).toEqual({ unassignedCount: 1 });
      expect(res.jobs.oldestNonTerminalCreatedAt).toBe('2026-10-13T11:00:00.000Z');
      expect(JSON.stringify(res)).not.toMatch(/secret|overdue|Id"|address/i);
    });

    it('GET-only under admin/operations/deliveries/summary with delivery:read:any, registered before Work 36’s :deliveryJobId controller', () => {
      expect(Reflect.getMetadata('path', AdminDeliverySummaryController)).toBe('admin/operations/deliveries/summary');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminDeliverySummaryController)).toEqual(['delivery:read:any']);
      expect(Object.getOwnPropertyNames(AdminDeliverySummaryController.prototype).filter((m) => m !== 'constructor')).toEqual(['get']);
      expect(Reflect.getMetadata('method', AdminDeliverySummaryController.prototype.get)).toBe(0);
      const controllers = Reflect.getMetadata('controllers', AdminModule) as unknown[];
      expect(controllers.indexOf(AdminDeliverySummaryController)).toBeGreaterThanOrEqual(0);
      expect(controllers.indexOf(AdminDeliverySummaryController)).toBeLessThan(controllers.indexOf(AdminDeliveryOperationsController));
    });
  });
});
