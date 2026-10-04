import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { IdentityEventType } from '../../domain/events';
import {
  IRefreshTokenRepository,
  ISessionRepository,
} from '../../domain/repositories/auth.repositories';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { PermissionChangeService } from '../services/permission-change.service';
import { SuspendUserCommand } from './suspend-user.command';

function fakeUser(status: AccountStatus = AccountStatus.ACTIVE): User {
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
    permVersion: 1,
    deletionRequestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
}

describe('SuspendUserCommand', () => {
  let users: jest.Mocked<IUserRepository>;
  let sessions: jest.Mocked<ISessionRepository>;
  let refreshTokens: jest.Mocked<IRefreshTokenRepository>;
  let permissionChange: jest.Mocked<PermissionChangeService>;
  let outbox: jest.Mocked<OutboxService>;
  let audit: jest.Mocked<AuditService>;
  let command: SuspendUserCommand;

  beforeEach(() => {
    users = {
      findById: jest.fn().mockResolvedValue(fakeUser()),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IUserRepository>;
    sessions = { revokeAllForUser: jest.fn().mockResolvedValue(2) } as unknown as jest.Mocked<ISessionRepository>;
    refreshTokens = { revokeAllForUser: jest.fn().mockResolvedValue(2) } as unknown as jest.Mocked<IRefreshTokenRepository>;
    permissionChange = { propagate: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<PermissionChangeService>;
    outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<OutboxService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new SuspendUserCommand(users, sessions, refreshTokens, permissionChange, outbox, audit);
  });

  it('suspends the account and cuts every active credential', async () => {
    await command.execute({ targetUserId: 'user-1', reason: 'fraud', actorUserId: 'admin-1' });

    const saved = (users.save.mock.calls[0][0] as User).toProps();
    expect(saved.status).toBe(AccountStatus.SUSPENDED);
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('user-1');
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('user-1');
    expect(permissionChange.propagate).toHaveBeenCalledWith(['user-1']);
    expect(outbox.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: IdentityEventType.AccountSuspended }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity.account.suspended' }),
    );
  });

  it('persists the status change before bumping permVersion', async () => {
    const order: string[] = [];
    users.save.mockImplementation(async () => {
      order.push('save');
    });
    permissionChange.propagate.mockImplementation(async () => {
      order.push('propagate');
    });

    await command.execute({ targetUserId: 'user-1', reason: 'fraud', actorUserId: 'admin-1' });

    expect(order).toEqual(['save', 'propagate']);
  });

  it('refuses self-suspension', async () => {
    await expect(
      command.execute({ targetUserId: 'admin-1', reason: 'oops', actorUserId: 'admin-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION });
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('rejects suspending a deleted account', async () => {
    users.findById.mockResolvedValue(fakeUser(AccountStatus.DELETED));

    await expect(
      command.execute({ targetUserId: 'user-1', reason: 'fraud', actorUserId: 'admin-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('404s for an unknown user', async () => {
    users.findById.mockResolvedValue(null);

    await expect(
      command.execute({ targetUserId: 'missing', reason: 'fraud', actorUserId: 'admin-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
