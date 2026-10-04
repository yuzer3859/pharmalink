import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import {
  CodDisputeProps,
  CodDisputeResolutionResult,
  CodDisputeStatus,
  ICodDisputeAdminPort,
} from '../../delivery/application/ports/inbound/cod-dispute-admin.port';
import {
  ADMIN_COD_DISPUTE_RESOLVED,
  ResolveCodDisputeCommand,
} from './commands/resolve-cod-dispute.command';
import { GetCodDisputeQuery } from './queries/get-cod-dispute.query';
import {
  DEFAULT_COD_DISPUTE_PAGE_SIZE,
  ListCodDisputesQuery,
  MAX_COD_DISPUTE_PAGE_SIZE,
} from './queries/list-cod-disputes.query';

/**
 * Module 16 Work 06's application layer, with Module 08 behind a fake port. The claims here are
 * about forwarding and recording; which resolutions Module 08 accepts is Module 08's claim, made
 * against PostgreSQL in `test/admin/admin-cod-disputes.e2e-spec.ts`.
 */
describe('Admin COD dispute management (application)', () => {
  const NOW = new Date('2026-09-17T12:00:00.000Z');

  function dispute(overrides: Partial<CodDisputeProps> = {}): CodDisputeProps {
    return {
      id: 'dsp-1',
      collectionId: 'col-1',
      reason: 'Short by 4,500 at the cash desk.',
      status: CodDisputeStatus.OPEN,
      openedByUserId: 'finance-1',
      openedAt: new Date('2026-09-17T10:00:00.000Z'),
      resolvedByUserId: null,
      resolvedAt: null,
      resolutionNote: null,
      ...overrides,
    };
  }

  function resolved(overrides: Partial<CodDisputeResolutionResult> = {}): CodDisputeResolutionResult {
    return {
      dispute: dispute({
        status: CodDisputeStatus.RESOLVED,
        resolvedByUserId: 'finance-2',
        resolvedAt: NOW,
        resolutionNote: 'Driver handed over the balance.',
      }),
      collectionId: 'col-1',
      previousStatus: CodDisputeStatus.OPEN,
      changed: true,
      ...overrides,
    };
  }

  let port: jest.Mocked<ICodDisputeAdminPort>;
  let audit: jest.Mocked<AuditService>;

  beforeEach(() => {
    port = { listDisputes: jest.fn(), getDispute: jest.fn(), resolveDispute: jest.fn() };
    audit = {
      record: jest.fn().mockResolvedValue({ id: 'audit-1', hash: 'h' }),
    } as unknown as jest.Mocked<AuditService>;
  });

  describe('ListCodDisputesQuery', () => {
    let query: ListCodDisputesQuery;

    beforeEach(() => {
      query = new ListCodDisputesQuery(port);
      port.listDisputes.mockResolvedValue({ items: [], total: 0, page: 1, size: 20 });
    });

    it('forwards every column filter Module 08 supports and no default status', async () => {
      const from = new Date('2026-09-01T00:00:00.000Z');
      await query.execute({
        status: CodDisputeStatus.OPEN,
        collectionId: 'col-1',
        driverId: 'drv-1',
        jobId: 'job-1',
        orderId: 'ord-1',
        openedFrom: from,
      });
      expect(port.listDisputes).toHaveBeenCalledWith(
        {
          status: CodDisputeStatus.OPEN,
          collectionId: 'col-1',
          driverId: 'drv-1',
          jobId: 'job-1',
          orderId: 'ord-1',
          openedFrom: from,
          openedTo: undefined,
          resolvedFrom: undefined,
          resolvedTo: undefined,
        },
        1,
        DEFAULT_COD_DISPUTE_PAGE_SIZE,
      );
      await query.execute({});
      expect(port.listDisputes.mock.calls[1][0].status).toBeUndefined();
    });

    it('clamps the page size and floors a fractional page; defaults for non-positive values', async () => {
      await query.execute({ page: 4.2, size: 999 });
      expect(port.listDisputes).toHaveBeenCalledWith(expect.anything(), 4, MAX_COD_DISPUTE_PAGE_SIZE);
      await query.execute({ page: 0, size: -3 });
      expect(port.listDisputes).toHaveBeenCalledWith(expect.anything(), 1, DEFAULT_COD_DISPUTE_PAGE_SIZE);
    });
  });

  describe('GetCodDisputeQuery', () => {
    it('answers NOT_FOUND for an unknown id', async () => {
      port.getDispute.mockResolvedValue(null);
      await expect(new GetCodDisputeQuery(port).execute('missing')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('ResolveCodDisputeCommand', () => {
    let command: ResolveCodDisputeCommand;

    beforeEach(() => {
      command = new ResolveCodDisputeCommand(port, audit);
      port.resolveDispute.mockResolvedValue(resolved());
    });

    it('forwards the authenticated actor and the note, and nothing else, to Module 08', async () => {
      await command.execute({
        actorUserId: 'finance-2',
        disputeId: 'dsp-1',
        resolutionNote: 'Driver handed over the balance.',
        ip: '10.0.0.1',
      });
      expect(port.resolveDispute).toHaveBeenCalledWith({
        actorUserId: 'finance-2',
        disputeId: 'dsp-1',
        resolutionNote: 'Driver handed over the balance.',
      });
    });

    it('records the admin action after Module 08 accepted, with the transition', async () => {
      await command.execute({
        actorUserId: 'finance-2',
        disputeId: 'dsp-1',
        resolutionNote: 'Driver handed over the balance.',
        ip: '10.0.0.1',
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      const [entry] = audit.record.mock.calls[0];
      expect(entry).toMatchObject({
        actorUserId: 'finance-2',
        action: ADMIN_COD_DISPUTE_RESOLVED,
        resourceType: 'CodDispute',
        resourceId: 'dsp-1',
        ip: '10.0.0.1',
      });
      expect(entry.context).toEqual({
        disputeId: 'dsp-1',
        collectionId: 'col-1',
        previousStatus: CodDisputeStatus.OPEN,
        status: CodDisputeStatus.RESOLVED,
        changed: true,
        resolutionNote: 'Driver handed over the balance.',
        resolvedByUserId: 'finance-2',
        resolvedAt: NOW.toISOString(),
      });
    });

    it('records a Module 08 replay as an unchanged action', async () => {
      port.resolveDispute.mockResolvedValue(
        resolved({ previousStatus: CodDisputeStatus.RESOLVED, changed: false }),
      );
      const result = await command.execute({
        actorUserId: 'finance-2',
        disputeId: 'dsp-1',
        resolutionNote: 'Driver handed over the balance.',
        ip: null,
      });
      expect(result.changed).toBe(false);
      const [entry] = audit.record.mock.calls[0];
      expect(entry.context).toMatchObject({ previousStatus: CodDisputeStatus.RESOLVED, changed: false });
    });

    it('writes no audit entry when Module 08 refuses', async () => {
      port.resolveDispute.mockRejectedValue(
        new ApiException(ErrorCode.CONFLICT, 'COD dispute is not open.'),
      );
      await expect(
        command.execute({ actorUserId: 'finance-2', disputeId: 'dsp-1', resolutionNote: 'other', ip: null }),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
