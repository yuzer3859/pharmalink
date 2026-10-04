import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IHasher } from '../ports/hasher.port';
import { INotificationPort } from '../ports/notification.port';
import { PermissionChangeService } from '../services/permission-change.service';
import { ChangePasswordCommand } from './change-password.command';
import { LogoutAllCommand } from './logout.command';

function fakeUser(passwordHash: string | null = 'old-hash'): User {
  return User.rehydrate({
    id: 'user-1',
    phone: '+251911234567',
    email: null,
    passwordHash,
    primaryRole: PrimaryRole.CUSTOMER,
    status: AccountStatus.ACTIVE,
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

describe('ChangePasswordCommand', () => {
  let users: jest.Mocked<IUserRepository>;
  let hasher: jest.Mocked<IHasher>;
  let notifications: jest.Mocked<INotificationPort>;
  let logoutAll: jest.Mocked<LogoutAllCommand>;
  let permissionChange: jest.Mocked<PermissionChangeService>;
  let audit: jest.Mocked<AuditService>;
  let command: ChangePasswordCommand;

  const validInput = {
    userId: 'user-1',
    oldPassword: 'OldPassw0rd',
    newPassword: 'NewPassw0rd',
  };

  beforeEach(() => {
    users = {
      findById: jest.fn().mockResolvedValue(fakeUser()),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IUserRepository>;
    hasher = {
      verify: jest.fn().mockResolvedValue(true),
      hash: jest.fn().mockResolvedValue('new-hash'),
    } as unknown as jest.Mocked<IHasher>;
    notifications = { send: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<INotificationPort>;
    logoutAll = { execute: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<LogoutAllCommand>;
    permissionChange = { propagate: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<PermissionChangeService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;

    command = new ChangePasswordCommand(
      users,
      hasher,
      notifications,
      logoutAll,
      permissionChange,
      audit,
    );
  });

  it('requires the current password, then rotates and revokes', async () => {
    const result = await command.execute(validInput);

    expect(hasher.verify).toHaveBeenCalledWith('OldPassw0rd', 'old-hash');
    const saved = (users.save.mock.calls[0][0] as User).toProps();
    expect(saved.passwordHash).toBe('new-hash');
    expect(logoutAll.execute).toHaveBeenCalledWith('user-1', 'PASSWORD_CHANGED');
    expect(permissionChange.propagate).toHaveBeenCalledWith(['user-1']);
    expect(result).toEqual({ changed: true });
  });

  it('rejects a wrong current password with AUTH_INVALID_CREDENTIALS', async () => {
    hasher.verify.mockResolvedValue(false);

    await expect(command.execute(validInput)).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_CREDENTIALS,
    });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('refuses to reuse the current password', async () => {
    await expect(
      command.execute({ ...validInput, newPassword: validInput.oldPassword }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('rejects a weak new password', async () => {
    await expect(command.execute({ ...validInput, newPassword: 'weak' })).rejects.toMatchObject({
      code: ErrorCode.AUTH_WEAK_PASSWORD,
    });
  });

  it('rejects an account with no password credential', async () => {
    users.findById.mockResolvedValue(fakeUser(null));

    await expect(command.execute(validInput)).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_CREDENTIALS,
    });
    expect(hasher.verify).not.toHaveBeenCalled();
  });
});
