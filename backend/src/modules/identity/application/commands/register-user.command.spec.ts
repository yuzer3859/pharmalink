import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { User } from '../../domain/entities/user.entity';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IRoleAssignmentRepository } from '../../domain/repositories/role-assignment.repository';
import { IHasher } from '../ports/hasher.port';
import { INotificationPort, NotificationChannel } from '../ports/notification.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { RegisterUserCommand } from './register-user.command';

function fakeUser(overrides: Partial<{ id: string; phone: string | null; email: string | null }> = {}): User {
  const now = new Date();
  return User.rehydrate({
    id: overrides.id ?? 'user-1',
    phone: overrides.phone ?? '+251912345678',
    email: overrides.email ?? null,
    passwordHash: 'hashed',
    primaryRole: PrimaryRole.CUSTOMER,
    status: AccountStatus.PENDING_VERIFICATION,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: null,
    emailVerifiedAt: null,
    faydaVerifiedAt: null,
    guardianId: null,
    permVersion: 1,
    deletionRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
}

describe('RegisterUserCommand', () => {
  function build(overrides: { existingUser?: User | null; deliverable?: NotificationChannel[] } = {}) {
    const users: jest.Mocked<IUserRepository> = {
      findById: jest.fn(),
      findByPhone: jest.fn().mockResolvedValue(overrides.existingUser ?? null),
      findByEmail: jest.fn().mockResolvedValue(overrides.existingUser ?? null),
      findByIdentifier: jest.fn(),
      search: jest.fn(),
      create: jest.fn().mockResolvedValue(fakeUser()),
      save: jest.fn(),
    };
    const hasher: jest.Mocked<IHasher> = {
      hash: jest.fn().mockResolvedValue('hashed'),
      verify: jest.fn(),
    };
    const uow: IUnitOfWork = { run: (work) => work(undefined) };
    const roleAssignments: jest.Mocked<IRoleAssignmentRepository> = {
      assignByRoleKey: jest.fn().mockResolvedValue(undefined),
    };
    const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

    const deliverable = new Set(overrides.deliverable ?? ['SMS', 'EMAIL']);
    const notifications: jest.Mocked<INotificationPort> = {
      canDeliver: jest.fn((channel: NotificationChannel) => deliverable.has(channel)),
      send: jest.fn(),
    };

    const command = new RegisterUserCommand(users, hasher, uow, roleAssignments, outbox, notifications);
    return { command, users, hasher, roleAssignments, outbox, notifications };
  }

  it('registers a customer by phone and returns a masked verification target', async () => {
    const { command, roleAssignments, outbox } = build();

    const result = await command.execute({ phone: '0912345678', password: 'Str0ngPass' });

    expect(result.status).toBe(AccountStatus.PENDING_VERIFICATION);
    expect(result.verification.channel).toBe('SMS');
    expect(result.verification.target).toContain('****');
    expect(roleAssignments.assignByRoleKey).toHaveBeenCalledWith('user-1', 'CUSTOMER', null, undefined);
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('rejects when neither phone nor email is provided', async () => {
    const { command } = build();
    await expect(command.execute({ password: 'Str0ngPass' })).rejects.toThrow();
  });

  it('rejects a weak password', async () => {
    const { command } = build();
    await expect(command.execute({ phone: '0912345678', password: 'weak' })).rejects.toThrow();
  });

  it('rejects a duplicate phone number', async () => {
    const { command } = build({ existingUser: fakeUser() });
    await expect(
      command.execute({ phone: '0912345678', password: 'Str0ngPass' }),
    ).rejects.toMatchObject({ code: 'AUTH_DUPLICATE_IDENTIFIER' });
  });

  // Work 62: e-mail is the verification channel whenever an address is given, and the channel must
  // be deliverable before any account exists.
  it('verifies by e-mail when both e-mail and phone are given, even though SMS is deliverable', async () => {
    const { command, notifications } = build();
    const result = await command.execute({ phone: '0912345678', email: 'Abebe@Example.com', password: 'Str0ngPass' });
    expect(result.verification.channel).toBe('EMAIL');
    expect(result.verification.target).toContain('@');
    expect(result.verification.target).not.toContain('abebe@example.com');
    expect(notifications.canDeliver).toHaveBeenCalledWith('EMAIL');
    expect(notifications.canDeliver).not.toHaveBeenCalledWith('SMS');
  });

  it('refuses phone-only registration while SMS cannot deliver, before creating anything', async () => {
    const { command, users, outbox, roleAssignments } = build({ deliverable: ['EMAIL'] });
    await expect(command.execute({ phone: '0912345678', password: 'Str0ngPass' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'email', reason: 'SMS_UNAVAILABLE' },
    });
    expect(users.create).not.toHaveBeenCalled();
    expect(roleAssignments.assignByRoleKey).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('accepts e-mail plus phone while SMS cannot deliver, verifying by e-mail', async () => {
    const { command, users } = build({ deliverable: ['EMAIL'] });
    const result = await command.execute({ phone: '0912345678', email: 'abebe@example.com', password: 'Str0ngPass' });
    expect(result.verification.channel).toBe('EMAIL');
    expect(users.create).toHaveBeenCalledTimes(1);
  });

  it('refuses e-mail registration while e-mail cannot deliver (no provider), before creating anything', async () => {
    const { command, users, outbox } = build({ deliverable: ['SMS'] });
    await expect(command.execute({ email: 'abebe@example.com', password: 'Str0ngPass' })).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      details: { channel: 'EMAIL', reason: 'NOT_CONFIGURED' },
    });
    expect(users.create).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });
});
