import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { User } from '../../domain/entities/user.entity';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IRoleAssignmentRepository } from '../../domain/repositories/role-assignment.repository';
import { IHasher } from '../ports/hasher.port';
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
  function build(overrides: { existingUser?: User | null } = {}) {
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

    const command = new RegisterUserCommand(users, hasher, uow, roleAssignments, outbox);
    return { command, users, hasher, roleAssignments, outbox };
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
});
