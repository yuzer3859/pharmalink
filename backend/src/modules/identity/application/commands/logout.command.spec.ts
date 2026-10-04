import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  IRefreshTokenRepository,
  ISessionRepository,
  RefreshTokenRecord,
} from '../../domain/repositories/auth.repositories';
import { ITokenService } from '../ports/token.service';
import { LogoutAllCommand, LogoutCommand } from './logout.command';

describe('LogoutCommand', () => {
  it('revokes the token family for a known refresh token', async () => {
    const record: RefreshTokenRecord = {
      id: 'rt-1',
      userId: 'user-1',
      deviceId: 'device-1',
      familyId: 'family-1',
      expiresAt: new Date(),
      usedAt: null,
      revokedAt: null,
      replacedBy: null,
    };
    const refreshTokens = {
      findByHash: jest.fn().mockResolvedValue(record),
      revokeFamily: jest.fn(),
    } as unknown as IRefreshTokenRepository;
    const tokenService = { hashRefreshToken: jest.fn().mockReturnValue('hash') } as unknown as ITokenService;

    const command = new LogoutCommand(refreshTokens, tokenService);
    await command.execute('plain-token');

    expect(refreshTokens.revokeFamily).toHaveBeenCalledWith('family-1');
  });

  it('does nothing for an unknown token', async () => {
    const refreshTokens = {
      findByHash: jest.fn().mockResolvedValue(null),
      revokeFamily: jest.fn(),
    } as unknown as IRefreshTokenRepository;
    const tokenService = { hashRefreshToken: jest.fn().mockReturnValue('hash') } as unknown as ITokenService;

    const command = new LogoutCommand(refreshTokens, tokenService);
    await expect(command.execute('nope')).resolves.toBeUndefined();
    expect(refreshTokens.revokeFamily).not.toHaveBeenCalled();
  });
});

describe('LogoutAllCommand', () => {
  it('revokes all refresh tokens and sessions, then publishes SessionsRevoked', async () => {
    const refreshTokens = { revokeAllForUser: jest.fn().mockResolvedValue(2) } as unknown as IRefreshTokenRepository;
    const sessions = { revokeAllForUser: jest.fn().mockResolvedValue(1) } as unknown as ISessionRepository;
    const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

    const command = new LogoutAllCommand(refreshTokens, sessions, outbox);
    await command.execute('user-1');

    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('user-1');
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('user-1');
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });
});
