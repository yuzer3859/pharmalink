import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../../prisma/rbac-catalog';
import { PERMISSIONS_KEY } from '../../../../shared/rbac/permissions.decorator';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { InMemoryDocumentStorage } from '../../../../shared/storage/in-memory-document-storage';
import { AdminReportsController } from '../../interface/controllers/admin-reports.controller';
import { IReportJobRepository, ReportJobRow } from '../ports/report-job.repository.port';
import { buildCsv, csvCell, MAX_REPORT_ROWS, REPORT_TYPE_PERMISSION } from './report-builders';
import { MAX_REPORT_ATTEMPTS, ReportService } from './report.service';

describe('Reports (Work 90)', () => {
  describe('CSV', () => {
    it('quotes what needs quoting and neutralises formulas', () => {
      expect(csvCell('plain')).toBe('plain');
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
      for (const f of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(f).replace(/^"/, '').startsWith("'")).toBe(true);
      expect(csvCell(-5)).toBe('-5');
      expect(csvCell(true)).toBe('true');
      expect(csvCell(null)).toBe('');
      expect(csvCell(new Date('2026-11-06T00:00:00Z'))).toBe('2026-11-06T00:00:00.000Z');
      expect(csvCell('ሰላም')).toBe('ሰላም');
    });

    it('reads every page, starts with a BOM and a header, and stops at the row cap', async () => {
      const pages = [[['a'], ['b']], [['c']]];
      const all = await buildCsv(['x'], async (page) => ({ rows: pages[page - 1], more: page < pages.length }));
      expect(all).toMatchObject({ rowCount: 3, truncated: false });
      expect(all.content.toString('utf8')).toBe('﻿x\r\na\r\nb\r\nc\r\n');
      const capped = await buildCsv(['x'], async (page) => ({ rows: pages[page - 1], more: page < pages.length }), 2);
      expect(capped).toMatchObject({ rowCount: 2, truncated: true });
      // One page holding more rows than the cap.
      const oneBigPage = await buildCsv(['x'], async () => ({ rows: [['a'], ['b'], ['c']], more: false }), 2);
      expect(oneBigPage).toMatchObject({ rowCount: 2, truncated: true });
      expect(oneBigPage.content.toString('utf8')).toBe('﻿x\r\na\r\nb\r\n');
      const exact = await buildCsv(['x'], async () => ({ rows: [['a'], ['b']], more: false }), 2);
      expect(exact).toMatchObject({ rowCount: 2, truncated: false });
      expect(MAX_REPORT_ROWS).toBe(100_000);
    });
  });

  describe('worker', () => {
    const job = (over: Partial<ReportJobRow> = {}): ReportJobRow =>
      ({ id: 'j1', type: 'ORDERS', status: 'RUNNING', params: { from: '2026-11-01', to: '2026-11-02' }, requestedByUserId: '11111111-1111-4111-8111-111111111111', attempts: 1, startedAt: new Date('2026-11-03T00:00:00Z'), ...over }) as ReportJobRow;
    const repo = (claimed: ReportJobRow | null) =>
      ({ requeueStale: jest.fn(), claimNext: jest.fn().mockResolvedValue(claimed), succeed: jest.fn(), fail: jest.fn(), requeue: jest.fn() }) as unknown as jest.Mocked<IReportJobRepository>;
    const service = (jobs: IReportJobRepository, orders: unknown) =>
      new ReportService(jobs, new InMemoryDocumentStorage('http://x'), {} as never, orders as never, {} as never, {} as never, { record: jest.fn() } as never);

    it('reads only up to when the build started, and stores the file', async () => {
      const jobs = repo(job({ startedAt: new Date('2026-11-02T12:00:00Z') }));
      const orders = { listOrders: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
      await service(jobs, orders).runNext(new Date('2026-11-02T12:00:00Z'));
      expect(orders.listOrders).toHaveBeenCalledWith({ createdFrom: new Date('2026-11-01T00:00:00Z'), createdTo: new Date('2026-11-02T12:00:00Z') }, 1, 100);
      expect(jobs.succeed).toHaveBeenCalledWith('j1', expect.objectContaining({ rowCount: 0, truncated: false, storageRef: expect.stringMatching(/^doc:reports\//) }));
    });

    it('retries a failing build, then marks it failed', async () => {
      const failing = { listOrders: jest.fn().mockRejectedValue(new Error('db down')) };
      const early = repo(job({ attempts: 1 }));
      await service(early, failing).runNext();
      expect(early.requeue).toHaveBeenCalledWith('j1');
      expect(early.fail).not.toHaveBeenCalled();
      const last = repo(job({ attempts: MAX_REPORT_ATTEMPTS }));
      await service(last, failing).runNext();
      expect(last.fail).toHaveBeenCalledWith('j1', 'db down', expect.any(Date));
    });

    it('is idle when nothing is queued', async () => {
      expect(await service(repo(null), {}).runNext()).toBeNull();
    });
  });

  it('grants report generation to ADMIN and FINANCE_OFFICER, and each type its own read authority', () => {
    expect(PERMISSIONS.some((p) => p.key === 'report:generate:any')).toBe(true);
    for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
      expect({ role, ok: hasPermission(grants, 'report:generate:any') }).toEqual({ role, ok: ['ADMIN', 'FINANCE_OFFICER', 'SUPER_ADMIN'].includes(role) });
    }
    for (const p of Object.values(REPORT_TYPE_PERMISSION)) expect(PERMISSIONS.some((x) => x.key === p)).toBe(true);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminReportsController)).toEqual(['report:generate:any']);
  });
});
