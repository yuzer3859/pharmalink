import { computeEntryHash } from '../../../shared/audit/audit-hash';
import { AuditRecordView, IAuditReadPort } from '../../../shared/audit/audit-read.port';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { GetAuditEntryQuery } from './queries/get-audit-entry.query';
import {
  DEFAULT_AUDIT_PAGE_SIZE,
  ListAuditQuery,
  MAX_AUDIT_PAGE_SIZE,
} from './queries/list-audit.query';

/**
 * Module 16 Work 05's application layer, with the audit read port faked. The claims here are
 * about what is forwarded and how a stored entry's own link is checked; that the real table
 * pages deterministically and that reading writes nothing are asserted against PostgreSQL in
 * `test/admin/admin-audit.e2e-spec.ts`.
 */
describe('Admin audit explorer (application)', () => {
  const CREATED_AT = new Date('2026-09-17T12:00:00.000Z');

  function stored(overrides: Partial<AuditRecordView> = {}): AuditRecordView {
    const fields = {
      actorUserId: 'admin-1',
      action: 'CONFIG_CHANGED',
      resourceType: 'PlatformConfig',
      resourceId: 'delivery.offerTtlSeconds',
      context: { version: 2, reason: 'tuning' },
      ip: '10.0.0.1',
      createdAt: CREATED_AT.toISOString(),
    };
    const prevHash = 'a'.repeat(64);
    return {
      id: 'audit-1',
      ...fields,
      createdAt: CREATED_AT,
      prevHash,
      hash: computeEntryHash(prevHash, fields),
      ...overrides,
    };
  }

  let port: jest.Mocked<IAuditReadPort>;

  beforeEach(() => {
    port = { search: jest.fn(), findById: jest.fn() };
  });

  describe('ListAuditQuery', () => {
    let query: ListAuditQuery;

    beforeEach(() => {
      query = new ListAuditQuery(port);
      port.search.mockResolvedValue({ items: [stored()], total: 1, page: 1, size: 20 });
    });

    it('forwards every column filter and nothing else', async () => {
      const from = new Date('2026-09-01T00:00:00.000Z');
      const to = new Date('2026-09-18T00:00:00.000Z');
      await query.execute({
        action: 'CONFIG_CHANGED',
        actorUserId: 'admin-1',
        resourceType: 'PlatformConfig',
        resourceId: 'delivery.offerTtlSeconds',
        from,
        to,
      });
      expect(port.search).toHaveBeenCalledWith(
        {
          action: 'CONFIG_CHANGED',
          actorUserId: 'admin-1',
          resourceType: 'PlatformConfig',
          resourceId: 'delivery.offerTtlSeconds',
          from,
          to,
        },
        1,
        DEFAULT_AUDIT_PAGE_SIZE,
      );
    });

    it('clamps the page size and floors a fractional page', async () => {
      await query.execute({ page: 2.5, size: 5_000 });
      expect(port.search).toHaveBeenCalledWith(expect.anything(), 2, MAX_AUDIT_PAGE_SIZE);
    });

    it('falls back to defaults for a non-positive page or size', async () => {
      await query.execute({ page: 0, size: -1 });
      expect(port.search).toHaveBeenCalledWith(expect.anything(), 1, DEFAULT_AUDIT_PAGE_SIZE);
    });

    it('returns the page unchanged — hashes as stored', async () => {
      const page = await query.execute({});
      expect(page.total).toBe(1);
      expect(page.items[0].prevHash).toBe('a'.repeat(64));
      expect(page.items[0].hash).toHaveLength(64);
    });
  });

  describe('GetAuditEntryQuery', () => {
    let query: GetAuditEntryQuery;

    beforeEach(() => {
      query = new GetAuditEntryQuery(port);
    });

    it('reports hashValid=true for an entry whose stored hash matches its fields', async () => {
      port.findById.mockResolvedValue(stored());
      const view = await query.execute('audit-1');
      expect(view.hashValid).toBe(true);
      expect(view.hash).toBe(stored().hash);
    });

    it('reports hashValid=false for an entry whose fields were altered after writing', async () => {
      port.findById.mockResolvedValue(stored({ context: { version: 99, reason: 'tuning' } }));
      const view = await query.execute('audit-1');
      expect(view.hashValid).toBe(false);
    });

    it('reports hashValid=false when the previous-hash link was altered', async () => {
      port.findById.mockResolvedValue(stored({ prevHash: 'b'.repeat(64) }));
      const view = await query.execute('audit-1');
      expect(view.hashValid).toBe(false);
    });

    it('handles the genesis entry (no previous hash)', async () => {
      const fields = {
        actorUserId: null,
        action: 'PAYMENT_RECONCILIATION_SWEEP',
        resourceType: 'payment',
        resourceId: null,
        context: null,
        ip: null,
        createdAt: CREATED_AT.toISOString(),
      };
      port.findById.mockResolvedValue(
        stored({ ...fields, createdAt: CREATED_AT, prevHash: null, hash: computeEntryHash(null, fields) }),
      );
      const view = await query.execute('audit-1');
      expect(view.hashValid).toBe(true);
    });

    it('answers NOT_FOUND for an unknown id', async () => {
      port.findById.mockResolvedValue(null);
      await expect(query.execute('missing')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });
});
