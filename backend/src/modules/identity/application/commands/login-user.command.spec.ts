import { AccountStatus, DevicePlatform, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { User } from '../../domain/entities/user.entity';
import { ILoginHistoryRepository } from '../../domain/repositories/auth.repositories';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { AdminMfaAuditor } from '../services/admin-mfa-auditor.service';
import { IAdminMfaRepository } from '../../domain/repositories/admin-mfa.repository';
import { IHasher } from '../ports/hasher.port';
import { AdminMfaChallengeService } from '../services/admin-mfa-challenge.service';
import { AdminMfaPolicy } from '../services/admin-mfa-policy.service';
import { AuthSessionIssuerService, IssuedSession } from '../services/auth-session-issuer.service';
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

  function build(
    user: User | null,
    passwordMatches: boolean,
    mfa: { admin?: boolean | Error; enrolled?: boolean } = {},
  ) {
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

    const mfaPolicy = {
      requiresMfa: jest.fn(() =>
        mfa.admin instanceof Error ? Promise.reject(mfa.admin) : Promise.resolve(mfa.admin === true),
      ),
    } as unknown as AdminMfaPolicy;
    const mfaChallenges = {
      issue: jest.fn((_userId: string, purpose: 'ENROLL' | 'VERIFY') =>
        Promise.resolve({
          mfaRequired: true,
          challenge: { type: purpose === 'ENROLL' ? 'ENROLLMENT' : 'TOTP', token: 't'.repeat(43), expiresAt: new Date() },
        }),
      ),
    } as unknown as AdminMfaChallengeService;
    const mfaRepository = {
      findCredential: jest.fn().mockResolvedValue(mfa.enrolled ? { userId: 'user-1' } : null),
    } as unknown as IAdminMfaRepository;
    const audit = { record: jest.fn() } as unknown as AdminMfaAuditor;

    const command = new LoginUserCommand(
      users,
      hasher,
      loginHistory,
      sessionIssuer,
      mfaPolicy,
      mfaChallenges,
      mfaRepository,
      audit,
    );
    return { command, loginHistory, sessionIssuer, users, mfaChallenges, audit };
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

    expect((result as IssuedSession).accessToken).toBe('access');
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

  describe('platform administrators (Work 66)', () => {
    const input = { identifier: '+251912345678', password: 'Str0ngPass', deviceInfo };

    it('returns an ENROLLMENT challenge and no session when no authenticator is enrolled', async () => {
      const { command, sessionIssuer, loginHistory, mfaChallenges, audit } = build(
        fakeUser(AccountStatus.ACTIVE),
        true,
        { admin: true, enrolled: false },
      );

      const result = await command.execute(input);

      expect(result).toMatchObject({ mfaRequired: true, challenge: { type: 'ENROLLMENT' } });
      expect(result).not.toHaveProperty('accessToken');
      expect(result).not.toHaveProperty('refreshToken');
      expect(sessionIssuer.issue).not.toHaveBeenCalled();
      expect(mfaChallenges.issue).toHaveBeenCalledWith('user-1', 'ENROLL');
      expect(loginHistory.record).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'MFA_REQUIRED', failureReason: 'MFA_NOT_ENROLLED' }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'identity.mfa.challenge_issued', context: { purpose: 'ENROLL' } }),
      );
    });

    it('returns a TOTP challenge and no session when an authenticator is enrolled', async () => {
      const { command, sessionIssuer, mfaChallenges } = build(fakeUser(AccountStatus.ACTIVE), true, {
        admin: true,
        enrolled: true,
      });

      const result = await command.execute(input);

      expect(result).toMatchObject({ mfaRequired: true, challenge: { type: 'TOTP' } });
      expect(sessionIssuer.issue).not.toHaveBeenCalled();
      expect(mfaChallenges.issue).toHaveBeenCalledWith('user-1', 'VERIFY');
    });

    it('issues no challenge before the password is verified', async () => {
      const { command, mfaChallenges } = build(fakeUser(AccountStatus.ACTIVE), false, { admin: true });
      await expect(command.execute(input)).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
      expect(mfaChallenges.issue).not.toHaveBeenCalled();
    });

    it('fails closed when the administrator check cannot be completed', async () => {
      const { command, sessionIssuer } = build(fakeUser(AccountStatus.ACTIVE), true, {
        admin: new Error('database unavailable'),
      });
      await expect(command.execute(input)).rejects.toThrow('database unavailable');
      expect(sessionIssuer.issue).not.toHaveBeenCalled();
    });
  });
});
