import { AppConfigService } from '../../../../shared/config/app-config.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { User } from '../../domain/entities/user.entity';
import { IRefreshTokenRepository, RefreshTokenRecord } from '../../domain/repositories/auth.repositories';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { ITokenService } from '../ports/token.service';
import { RefreshTokenCommand } from './refresh-token.command';

function fakeUser(): User {
  const now = new Date();
  return User.rehydrate({
    id: 'user-1',
    phone: '+251912345678',
    email: null,
    passwordHash: 'hashed',
    primaryRole: PrimaryRole.CUSTOMER,
    status: AccountStatus.ACTIVE,
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

function fakeRecord(overrides: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord {
  return {
    id: 'rt-1',
    userId: 'user-1',
    deviceId: 'device-1',
    familyId: 'family-1',
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    revokedAt: null,
    replacedBy: null,
    ...overrides,
  };
}

function fakeConfig(): AppConfigService {
  return { refreshTokenTtlDays: 30, accessTokenTtlSeconds: 900 } as unknown as AppConfigService;
}

describe('RefreshTokenCommand', () => {
  function build(record: RefreshTokenRecord | null, user: User | null = fakeUser()) {
    const refreshTokens: jest.Mocked<IRefreshTokenRepository> = {
      create: jest.fn().mockResolvedValue(fakeRecord({ id: 'rt-2' })),
      findByHash: jest.fn().mockResolvedValue(record),
      markUsed: jest.fn(),
      revokeFamily: jest.fn(),
      revokeAllForUser: jest.fn(),
    };
    const users = { findById: jest.fn().mockResolvedValue(user) } as unknown as IUserRepository;
    const tokenService = {
      hashRefreshToken: jest.fn().mockReturnValue('hashed-token'),
      createRefreshToken: jest
        .fn()
        .mockResolvedValue({ token: 'new-plain', tokenHash: 'new-hash', familyId: 'family-1' }),
      issueAccessToken: jest.fn().mockReturnValue({ token: 'new-access', expiresAt: 999 }),
    } as unknown as ITokenService;
    const permissionResolver = { resolvePermissions: jest.fn().mockResolvedValue(['order:read:own']) };
    const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

    const command = new RefreshTokenCommand(
      refreshTokens,
      users,
      tokenService,
      permissionResolver as never,
      fakeConfig(),
      outbox,
    );
    return { command, refreshTokens, outbox };
  }

  it('rotates a valid refresh token', async () => {
    const { command, refreshTokens } = build(fakeRecord());
    const result = await command.execute({ refreshToken: 'plain-token' });

    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('new-plain');
    expect(refreshTokens.markUsed).toHaveBeenCalledWith('rt-1', 'rt-2');
  });

  it('rejects an unknown token', async () => {
    const { command } = build(null);
    await expect(command.execute({ refreshToken: 'nope' })).rejects.toMatchObject({
      code: 'AUTH_REFRESH_INVALID',
    });
  });

  it('detects reuse of an already-used token and revokes the family', async () => {
    const { command, refreshTokens, outbox } = build(fakeRecord({ usedAt: new Date() }));
    await expect(command.execute({ refreshToken: 'plain-token' })).rejects.toMatchObject({
      code: 'AUTH_REFRESH_REUSE_DETECTED',
    });
    expect(refreshTokens.revokeFamily).toHaveBeenCalledWith('family-1');
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired token', async () => {
    const { command } = build(fakeRecord({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(command.execute({ refreshToken: 'plain-token' })).rejects.toMatchObject({
      code: 'AUTH_REFRESH_INVALID',
    });
  });
});
