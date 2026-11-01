import { AppConfigService } from '../../../../shared/config/app-config.service';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, DevicePlatform, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import {
  IDeviceRepository,
  IRefreshTokenRepository,
  ISessionRepository,
} from '../../domain/repositories/auth.repositories';
import { ITokenService } from '../ports/token.service';
import { AdminMfaPolicy } from './admin-mfa-policy.service';
import { AuthSessionIssuerService } from './auth-session-issuer.service';

function fakeUser(role: PrimaryRole): User {
  const now = new Date();
  return User.rehydrate({
    id: 'user-1',
    phone: null,
    email: 'ops@example.com',
    passwordHash: 'hashed',
    primaryRole: role,
    status: AccountStatus.ACTIVE,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: null,
    emailVerifiedAt: now,
    faydaVerifiedAt: null,
    guardianId: null,
    permVersion: 2,
    deletionRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
}

describe('AuthSessionIssuerService — administrator MFA backstop (Work 66)', () => {
  const deviceInfo = { fingerprint: 'fp-1', platform: DevicePlatform.WEB };

  function build(admin: boolean) {
    const devices = { upsertForUser: jest.fn().mockResolvedValue({ id: 'device-1' }) } as unknown as IDeviceRepository;
    const sessions = { create: jest.fn() } as unknown as jest.Mocked<ISessionRepository>;
    const refreshTokens = { create: jest.fn() } as unknown as jest.Mocked<IRefreshTokenRepository>;
    const tokenService = {
      createRefreshToken: jest.fn().mockResolvedValue({ token: 'refresh', tokenHash: 'hash', familyId: 'family-1' }),
      issueAccessToken: jest.fn().mockReturnValue({ token: 'access', expiresAt: 1 }),
    } as unknown as jest.Mocked<ITokenService>;
    const resolver = { resolvePermissions: jest.fn().mockResolvedValue(['*']) };
    const config = { refreshTokenTtlDays: 30, accessTokenTtlSeconds: 900 } as unknown as AppConfigService;
    const policy = { requiresMfa: jest.fn().mockResolvedValue(admin) } as unknown as AdminMfaPolicy;
    const issuer = new AuthSessionIssuerService(devices, sessions, refreshTokens, tokenService, resolver as never, config, policy);
    return { issuer, sessions, refreshTokens, tokenService, devices };
  }

  it('refuses to issue anything to a platform administrator without MFA, whoever calls it', async () => {
    const m = build(true);
    await expect(
      m.issuer.issue({ user: fakeUser(PrimaryRole.ADMIN), deviceInfo, ip: null, userAgent: null }),
    ).rejects.toMatchObject({ code: 'AUTH_MFA_REQUIRED' });
    expect(m.devices.upsertForUser).not.toHaveBeenCalled();
    expect(m.sessions.create).not.toHaveBeenCalled();
    expect(m.refreshTokens.create).not.toHaveBeenCalled();
    expect(m.tokenService.issueAccessToken).not.toHaveBeenCalled();
  });

  it('records MFA assurance on the session, the refresh token and the access token', async () => {
    const m = build(true);
    const verifiedAt = new Date();
    await m.issuer.issue({ user: fakeUser(PrimaryRole.SUPER_ADMIN), deviceInfo, ip: null, userAgent: null, mfaVerifiedAt: verifiedAt });

    expect(m.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ mfaVerifiedAt: verifiedAt }));
    expect(m.refreshTokens.create).toHaveBeenCalledWith(expect.objectContaining({ mfaVerifiedAt: verifiedAt }));
    expect(m.tokenService.issueAccessToken).toHaveBeenCalledWith(expect.objectContaining({ mfa: true }), 900);
  });

  it('issues a normal session to a non-administrator, without MFA assurance', async () => {
    const m = build(false);
    const session = await m.issuer.issue({ user: fakeUser(PrimaryRole.CUSTOMER), deviceInfo, ip: null, userAgent: null });

    expect(session.accessToken).toBe('access');
    expect(m.refreshTokens.create).toHaveBeenCalledWith(expect.objectContaining({ mfaVerifiedAt: null }));
    expect(m.tokenService.issueAccessToken).toHaveBeenCalledWith(expect.not.objectContaining({ mfa: true }), 900);
  });
});
