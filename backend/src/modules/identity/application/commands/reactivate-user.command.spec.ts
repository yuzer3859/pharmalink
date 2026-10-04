import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { IdentityEventType } from '../../domain/events';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { PermissionChangeService } from '../services/permission-change.service';
import { ReactivateUserCommand } from './reactivate-user.command';

function fakeUser(status: AccountStatus): User {
  return User.rehydrate({
    id: 'user-1',
    phone: '+251911000000',
    email: null,
    passwordHash: 'hash',
    primaryRole: PrimaryRole.CUSTOMER,
    status,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: new Date(),
    emailVerifiedAt: null,
    faydaVerifiedAt: null,
    guardianId: null,
    permVersion: 2,
    deletionRequestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
}

describe('ReactivateUserCommand', () => {
  let users: jest.Mocked<IUserRepository>;
  let permissionChange: jest.Mocked<PermissionChangeService>;
  let outbox: jest.Mocked<OutboxService>;
  let audit: jest.Mocked<AuditService>;
  let command: ReactivateUserCommand;

  beforeEach(() => {
    users = {
      findById: jest.fn().mockResolvedValue(fakeUser(AccountStatus.SUSPENDED)),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IUserRepository>;
    permissionChange = { propagate: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<PermissionChangeService>;
    outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<OutboxService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new ReactivateUserCommand(users, permissionChange, outbox, audit);
  });

  it('returns a suspended account to ACTIVE and emits the event', async () => {
    await command.execute({ targetUserId: 'user-1', actorUserId: 'admin-1' });

    const saved = (users.save.mock.calls[0][0] as User).toProps();
    expect(saved.status).toBe(AccountStatus.ACTIVE);
    expect(permissionChange.propagate).toHaveBeenCalledWith(['user-1']);
    expect(outbox.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: IdentityEventType.AccountReactivated }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity.account.reactivated' }),
    );
  });

  it('rejects reactivating an account that is not suspended', async () => {
    users.findById.mockResolvedValue(fakeUser(AccountStatus.ACTIVE));

    await expect(
      command.execute({ targetUserId: 'user-1', actorUserId: 'admin-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION });
    expect(users.save).not.toHaveBeenCalled();
  });
});
