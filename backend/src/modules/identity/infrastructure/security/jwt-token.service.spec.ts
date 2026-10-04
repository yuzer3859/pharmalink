import { AppConfigService } from '../../../../shared/config/app-config.service';
import { JwtTokenService } from './jwt-token.service';

function fakeConfig(): AppConfigService {
  return {
    jwtAccessSecret: 'access-secret-at-least-16-chars',
    jwtRefreshSecret: 'refresh-secret-at-least-16-chars',
  } as unknown as AppConfigService;
}

describe('JwtTokenService', () => {
  const service = new JwtTokenService(fakeConfig());

  it('issues an access token that verifies back to the same claims', () => {
    const { token } = service.issueAccessToken(
      { sub: 'user-1', permissions: ['order:read:own'], permVersion: 2, deviceId: 'device-1' },
      900,
    );
    const claims = service.verifyAccessToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.permissions).toEqual(['order:read:own']);
    expect(claims.permVersion).toBe(2);
    expect(claims.deviceId).toBe('device-1');
  });

  it('rejects a tampered token', () => {
    const { token } = service.issueAccessToken(
      { sub: 'user-1', permissions: [], permVersion: 1 },
      900,
    );
    const [header, payload, signature] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'evil' }),
    ).toString('base64url');
    expect(() => service.verifyAccessToken(`${header}.${tamperedPayload}.${signature}`)).toThrow();
  });

  it('rejects an expired token', () => {
    const { token } = service.issueAccessToken({ sub: 'user-1', permissions: [], permVersion: 1 }, -1);
    expect(() => service.verifyAccessToken(token)).toThrow();
  });

  it('rejects a malformed token', () => {
    expect(() => service.verifyAccessToken('not-a-jwt')).toThrow();
  });

  it('creates unique refresh tokens with a stable, deterministic hash', async () => {
    const a = await service.createRefreshToken();
    const b = await service.createRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.familyId).not.toBe(b.familyId);
    expect(service.hashRefreshToken(a.token)).toBe(a.tokenHash);
    expect(service.hashRefreshToken(a.token)).toBe(service.hashRefreshToken(a.token));
  });
});
