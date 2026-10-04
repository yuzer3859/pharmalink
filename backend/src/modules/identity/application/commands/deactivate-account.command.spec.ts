import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IHasher } from '../ports/hasher.port';
import { PermissionChangeService } from '../services/permission-change.service';
import { DeactivateAccountCommand } from './deactivate-account.command';
import { LogoutAllCommand } from './logout.command';

function fakeUser(status = AccountStatus.ACTIVE): User {
  return User.rehydrate({
    id: 'user-1',
    phone: '+251911234567',
    email: null,
    passwordHash: 'hash',
    primaryRole: PrimaryRole.CUSTOMER,
    status,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: new Date(),
    emailVerifiedAt: null,
    faydaVerifiedAt: null,
    guardianId: null,
    permVersion: 1,
    deletionRequestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
}

describe('DeactivateAccountCommand', () => {
  let users: jest.Mocked<IUserRepository>;
  let hasher: jest.Mocked<IHasher>;
  let logoutAll: jest.Mocked<LogoutAllCommand>;
  let permissionChange: jest.Mocked<PermissionChangeService>;
  let audit: jest.Mocked<AuditService>;
  let command: DeactivateAccountCommand;

  beforeEach(() => {
    users = {
      findById: jest.fn().mockResolvedValue(fakeUser()),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IUserRepository>;
    hasher = { verify: jest.fn().mockResolvedValue(true) } as unknown as jest.Mocked<IHasher>;
    logoutAll = { execute: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<LogoutAllCommand>;
    permissionChange = { propagate: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<PermissionChangeService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new DeactivateAccountCommand(users, hasher, logoutAll, permissionChange, audit);
  });

  it('deactivates the account and cuts every session', async () => {
    const result = await command.execute({ userId: 'user-1', password: 'Str0ngPass' });

    const saved = (users.save.mock.calls[0][0] as User).toProps();
    expect(saved.status).toBe(AccountStatus.DEACTIVATED);
    expect(logoutAll.execute).toHaveBeenCalledWith('user-1', 'ACCOUNT_DEACTIVATED');
    expect(permissionChange.propagate).toHaveBeenCalledWith(['user-1']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity.account.deactivated' }),
    );
    expect(result).toEqual({ status: AccountStatus.DEACTIVATED });
  });

  it('rejects a wrong step-up password', async () => {
    hasher.verify.mockResolvedValue(false);

    await expect(
      command.execute({ userId: 'user-1', password: 'wrong' }),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_INVALID_CREDENTIALS });
    expect(users.save).not.toHaveBeenCalled();
    expect(logoutAll.execute).not.toHaveBeenCalled();
  });

  it('404s for an unknown user', async () => {
    users.findById.mockResolvedValue(null);

    await expect(
      command.execute({ userId: 'missing', password: 'Str0ngPass' }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
