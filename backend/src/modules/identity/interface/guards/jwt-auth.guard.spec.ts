import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { IPermVersionStore } from '../../application/ports/perm-version.port';
import { AccessTokenClaims, ITokenService } from '../../application/ports/token.service';
import { JwtAuthGuard } from './jwt-auth.guard';

function contextFor(authorization?: string): ExecutionContext {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: authorization ? { authorization } : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function claims(overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
  return { sub: 'user-1', permissions: ['order:read:own'], permVersion: 3, ...overrides };
}

describe('JwtAuthGuard', () => {
  let reflector: Reflector;
  let tokenService: jest.Mocked<ITokenService>;
  let permVersions: jest.Mocked<IPermVersionStore>;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    tokenService = { verifyAccessToken: jest.fn().mockReturnValue(claims()) } as unknown as jest.Mocked<ITokenService>;
    permVersions = {
      getCurrent: jest.fn().mockResolvedValue(3),
      invalidate: jest.fn(),
    } as unknown as jest.Mocked<IPermVersionStore>;
    guard = new JwtAuthGuard(reflector, tokenService, permVersions);
  });

  it('admits a token whose permVersion matches the current one', async () => {
    await expect(guard.canActivate(contextFor('Bearer token'))).resolves.toBe(true);
  });

  it('lets @Public routes through without a token', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);

    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
    expect(tokenService.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a token minted before a permission change', async () => {
    permVersions.getCurrent.mockResolvedValue(4);

    await expect(guard.canActivate(contextFor('Bearer token'))).rejects.toMatchObject({
      code: ErrorCode.TOKEN_EXPIRED,
    });
  });

  it('rejects a token for a user that no longer exists', async () => {
    permVersions.getCurrent.mockResolvedValue(null);

    await expect(guard.canActivate(contextFor('Bearer token'))).rejects.toMatchObject({
      code: ErrorCode.AUTH_TOKEN_INVALID,
    });
  });

  it('requires a bearer header', async () => {
    await expect(guard.canActivate(contextFor())).rejects.toMatchObject({
      code: ErrorCode.UNAUTHENTICATED,
    });
  });
});
