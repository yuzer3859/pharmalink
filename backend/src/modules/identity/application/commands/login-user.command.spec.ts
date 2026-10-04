import { AccountStatus, DevicePlatform, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { User } from '../../domain/entities/user.entity';
import { ILoginHistoryRepository } from '../../domain/repositories/auth.repositories';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IHasher } from '../ports/hasher.port';
import { AuthSessionIssuerService } from '../services/auth-session-issuer.service';
import { LoginUserCommand } from './login-user.command';

function fakeUser(status: AccountStatus, passwordHash: string | null = 'hashed'): User {
  const now = new Date();
  return User.rehydrate({
    id: 'user-1',
    phone: '+251912345678',
    email: null,
    passwordHash,
    primaryRole: PrimaryRole.CUSTOMER,
    status,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: now,
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

describe('LoginUserCommand', () => {
  const deviceInfo = { fingerprint: 'fp-1', platform: DevicePlatform.ANDROID };

  function build(user: User | null, passwordMatches: boolean) {
    const users = { findByIdentifier: jest.fn().mockResolvedValue(user) } as unknown as IUserRepository;
    const hasher = { verify: jest.fn().mockResolvedValue(passwordMatches) } as unknown as IHasher;
    const loginHistory: jest.Mocked<ILoginHistoryRepository> = {
      record: jest.fn(),
      listForUser: jest.fn(),
    };
    const sessionIssuer = {
      issue: jest.fn().mockResolvedValue({
        accessToken: 'access',
        accessTokenExpiresAt: 123,
        refreshToken: 'refresh',
        refreshTokenExpiresAt: new Date(),
      }),
    } as unknown as AuthSessionIssuerService;

    const command = new LoginUserCommand(users, hasher, loginHistory, sessionIssuer);
    return { command, loginHistory, sessionIssuer, users };
  }

  // Regression: identifiers are stored canonically, so a locally-formatted phone or a
  // mixed-case email must resolve to the same account instead of failing to authenticate.
  it.each(['0912345678', '912345678', '251912345678', '+251912345678'])(
    'accepts the phone form %s and looks the user up by E.164',
    async (typed) => {
      const { command, users } = build(fakeUser(AccountStatus.ACTIVE), true);

      await command.execute({ identifier: typed, password: 'Str0ngPass', deviceInfo });

      expect(users.findByIdentifier).toHaveBeenCalledWith('+251912345678');
    },
  );

  it('lower-cases an email identifier before lookup', async () => {
    const { command, users } = build(fakeUser(AccountStatus.ACTIVE), true);

    await command.execute({ identifier: 'User@Example.COM', password: 'Str0ngPass', deviceInfo });

    expect(users.findByIdentifier).toHaveBeenCalledWith('user@example.com');
  });

  it('records the canonical identifier in login history', async () => {
    const { command, loginHistory } = build(fakeUser(AccountStatus.ACTIVE), true);

    await command.execute({ identifier: '0912345678', password: 'Str0ngPass', deviceInfo });

    expect(loginHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: '+251912345678', outcome: 'SUCCESS' }),
    );
  });

  it('fails a malformed identifier without hitting the database', async () => {
    const { command, users, loginHistory } = build(fakeUser(AccountStatus.ACTIVE), true);

    await expect(
      command.execute({ identifier: 'garbage', password: 'Str0ngPass', deviceInfo }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(users.findByIdentifier).not.toHaveBeenCalled();
    expect(loginHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: 'IDENTIFIER_MALFORMED' }),
    );
  });

  it('logs in an active user with a matching password', async () => {
    const { command, loginHistory, sessionIssuer } = build(fakeUser(AccountStatus.ACTIVE), true);

    const result = await command.execute({
      identifier: '+251912345678',
      password: 'Str0ngPass',
      deviceInfo,
    });

    expect(result.accessToken).toBe('access');
    expect(sessionIssuer.issue).toHaveBeenCalledTimes(1);
    expect(loginHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'SUCCESS' }),
    );
  });

  it('rejects an unknown identifier without revealing that', async () => {
    const { command, loginHistory } = build(null, false);
    await expect(
      command.execute({ identifier: 'nobody', password: 'x', deviceInfo }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(loginHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILED' }),
    );
  });

  it('rejects a wrong password', async () => {
    const { command } = build(fakeUser(AccountStatus.ACTIVE), false);
    await expect(
      command.execute({ identifier: '+251912345678', password: 'wrong', deviceInfo }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('rejects a suspended account', async () => {
    const { command } = build(fakeUser(AccountStatus.SUSPENDED), true);
    await expect(
      command.execute({ identifier: '+251912345678', password: 'Str0ngPass', deviceInfo }),
    ).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_SUSPENDED' });
  });
});
