import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { CustomerProfile } from '../../domain/entities/customer-profile.entity';
import { IProfileRepository } from '../../domain/repositories/profile.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { UpdateProfileCommand } from './update-profile.command';

function build(profile: CustomerProfile) {
  const profiles: jest.Mocked<IProfileRepository> = {
    findByUserId: jest.fn(),
    findOrCreateByUserId: jest.fn().mockResolvedValue(profile),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;
  const command = new UpdateProfileCommand(profiles, uow, audit, outbox);
  return { command, profiles, audit, outbox };
}

describe('UpdateProfileCommand', () => {
  it('rejects an empty body', async () => {
    const { command } = build(CustomerProfile.createEmpty('p1', 'user-1'));
    await expect(command.execute({ userId: 'user-1' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('updates fullName and audits only field names', async () => {
    const { command, audit, outbox } = build(CustomerProfile.createEmpty('p1', 'user-1'));
    const result = await command.execute({ userId: 'user-1', fullName: 'Abebe Kebede' });
    expect(result.fullName).toBe('Abebe Kebede');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PROFILE_UPDATED', context: { fields: ['fullName'] } }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-Ethiopian secondaryPhone', async () => {
    const { command } = build(CustomerProfile.createEmpty('p1', 'user-1'));
    await expect(
      command.execute({ userId: 'user-1', secondaryPhone: '+15551234567' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a future dateOfBirth', async () => {
    const { command } = build(CustomerProfile.createEmpty('p1', 'user-1'));
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await expect(
      command.execute({ userId: 'user-1', dateOfBirth: tomorrow }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
