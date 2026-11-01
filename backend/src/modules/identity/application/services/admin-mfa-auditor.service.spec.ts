import { AuditService } from '../../../../shared/audit/audit.service';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { AdminMfaAuditor } from './admin-mfa-auditor.service';

describe('AdminMfaAuditor (Work 66)', () => {
  it('appends inside a Serializable unit of work, so a serialization conflict is retried', async () => {
    const uow = { run: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) } as unknown as jest.Mocked<IUnitOfWork>;
    const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    const params = { actorUserId: 'u', action: 'identity.mfa.challenge_failed', resourceType: 'user', resourceId: 'u' };

    await new AdminMfaAuditor(uow, audit).record(params);

    expect(uow.run).toHaveBeenCalledWith(expect.any(Function), { isolation: 'serializable' });
    expect(audit.record).toHaveBeenCalledWith(params, 'tx');
  });

  it('keeps retrying serialization conflicts for a few rounds, then gives up loudly', async () => {
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    const audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;
    const flaky = { run: jest.fn().mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict).mockResolvedValue(undefined) } as unknown as jest.Mocked<IUnitOfWork>;
    await new AdminMfaAuditor(flaky, audit).record({ action: 'a', resourceType: 'user' });
    expect(flaky.run).toHaveBeenCalledTimes(3);

    const stuck = { run: jest.fn().mockRejectedValue(conflict) } as unknown as jest.Mocked<IUnitOfWork>;
    await expect(new AdminMfaAuditor(stuck, audit).record({ action: 'a', resourceType: 'user' })).rejects.toBe(conflict);
    expect(stuck.run).toHaveBeenCalledTimes(5);
  });

  it('does not retry other failures', async () => {
    const audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;
    const broken = { run: jest.fn().mockRejectedValue(new Error('database down')) } as unknown as jest.Mocked<IUnitOfWork>;
    await expect(new AdminMfaAuditor(broken, audit).record({ action: 'a', resourceType: 'user' })).rejects.toThrow('database down');
    expect(broken.run).toHaveBeenCalledTimes(1);
  });
});
