import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IHasher } from '../ports/hasher.port';
import { PermissionChangeService } from '../services/permission-change.service';
import { LogoutAllCommand } from './logout.command';
import {
  DELETION_GRACE_DAYS,
  RequestAccountDeletionCommand,
} from './request-account-deletion.command';

function fakeUser(passwordHash: string | null = 'hash'): User {
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

describe('RequestAccountDeletionCommand', () => {
  let users: jest.Mocked<IUserRepository>;
  let hasher: jest.Mocked<IHasher>;
  let logoutAll: jest.Mocked<LogoutAllCommand>;
  let permissionChange: jest.Mocked<PermissionChangeService>;
  let audit: jest.Mocked<AuditService>;
  let command: RequestAccountDeletionCommand;

  beforeEach(() => {
    users = {
      findById: jest.fn().mockResolvedValue(fakeUser()),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IUserRepository>;
    hasher = { verify: jest.fn().mockResolvedValue(true) } as unknown as jest.Mocked<IHasher>;
    logoutAll = { execute: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<LogoutAllCommand>;
    permissionChange = { propagate: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<PermissionChangeService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new RequestAccountDeletionCommand(users, hasher, logoutAll, permissionChange, audit);
  });

  it('records the request, disables the account and returns the purge date', async () => {
    const result = await command.execute({ userId: 'user-1', password: 'Str0ngPass' });

    const saved = (users.save.mock.calls[0][0] as User).toProps();
    expect(saved.deletionRequestedAt).not.toBeNull();
    expect(saved.status).toBe(AccountStatus.DEACTIVATED);

    const expectedGap = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;
    expect(result.purgeEligibleAt.getTime() - result.requestedAt.getTime()).toBe(expectedGap);
    expect(logoutAll.execute).toHaveBeenCalledWith('user-1', 'DELETION_REQUESTED');
    expect(permissionChange.propagate).toHaveBeenCalledWith(['user-1']);
  });

  it('does not mark the record erased — the purge job owns deletedAt', async () => {
    await command.execute({ userId: 'user-1', password: 'Str0ngPass' });

    const saved = (users.save.mock.calls[0][0] as User).toProps();
    expect(saved.deletedAt).toBeNull();
  });

  it('requires the current password as step-up', async () => {
    hasher.verify.mockResolvedValue(false);

    await expect(
      command.execute({ userId: 'user-1', password: 'wrong' }),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_INVALID_CREDENTIALS });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('audits the request under a privacy action', async () => {
    await command.execute({ userId: 'user-1', password: 'Str0ngPass', reason: 'no longer needed' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'privacy.data_deletion_requested' }),
    );
  });
});
