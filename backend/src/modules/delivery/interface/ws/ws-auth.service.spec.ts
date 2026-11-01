import { IPermVersionStore } from '../../../identity/application/ports/perm-version.port';
import { AccessTokenClaims, ITokenService } from '../../../identity/application/ports/token.service';
import { WsAuthService } from './ws-auth.service';

describe('WsAuthService — the HTTP guard’s checks on a socket handshake', () => {
  function build(claims: AccessTokenClaims, state: { permVersion: number; mfaRequired: boolean } | null) {
    const tokens = { verifyAccessToken: jest.fn().mockReturnValue(claims) } as unknown as ITokenService;
    const permVersions = {
      getCurrent: jest.fn(),
      getAuthState: jest.fn().mockResolvedValue(state),
      invalidate: jest.fn(),
    } as unknown as IPermVersionStore;
    return new WsAuthService(tokens, permVersions);
  }
  const handshake = { auth: { token: 'access-token' } };
  const claims = (extra: Partial<AccessTokenClaims> = {}): AccessTokenClaims => ({
    sub: 'user-1',
    permissions: ['*'],
    permVersion: 2,
    ...extra,
  });

  it('authenticates a current token', async () => {
    await expect(build(claims(), { permVersion: 2, mfaRequired: false }).authenticate(handshake)).resolves.toEqual({
      userId: 'user-1',
      permissions: ['*'],
    });
  });

  it('refuses a stale permission version', async () => {
    await expect(build(claims(), { permVersion: 3, mfaRequired: false }).authenticate(handshake)).resolves.toBeNull();
  });

  it('refuses a platform administrator token without MFA assurance (Work 66)', async () => {
    await expect(build(claims(), { permVersion: 2, mfaRequired: true }).authenticate(handshake)).resolves.toBeNull();
  });

  it('accepts a platform administrator token with MFA assurance', async () => {
    await expect(
      build(claims({ mfa: true }), { permVersion: 2, mfaRequired: true }).authenticate(handshake),
    ).resolves.toEqual({ userId: 'user-1', permissions: ['*'] });
  });
});
