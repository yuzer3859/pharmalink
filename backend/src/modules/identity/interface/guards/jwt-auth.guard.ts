import { CanActivate, ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiException } from '../../../../shared/errors/api-exception';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { IPermVersionStore, PERM_VERSION_STORE } from '../../application/ports/perm-version.port';
import { ITokenService, TOKEN_SERVICE } from '../../application/ports/token.service';
import { ImpersonationService } from '../../application/services/impersonation.service';
import { IdentityErrors } from '../../domain/errors';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Stateless bearer-token authentication guard (module-01 §8, §12). Verifies the access JWT and
 * attaches an AuthenticatedPrincipal to the request in the exact shape PermissionsGuard expects,
 * so the two guards compose cleanly. Routes annotated with @Public bypass this entirely.
 *
 * The token carries a snapshot of the holder's permissions, so it must also carry the
 * `permVersion` that snapshot was taken at: any role/permission change bumps that version and
 * this guard then rejects the stale token, forcing a refresh that re-resolves permissions.
 * Without this check a revoked role would stay effective until the access token expired.
 *
 * Administrator MFA (Work 66): a platform administrator's token must also carry MFA assurance
 * (`mfa: true`, set only by the MFA sign-in). A token without it, including every token minted before
 * Work 66, or one minted before the account was promoted, is refused with `AUTH_MFA_REQUIRED`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_SERVICE) private readonly tokenService: ITokenService,
    @Inject(PERM_VERSION_STORE) private readonly permVersions: IPermVersionStore,
    // Work 85. Optional only for hand-built guard fixtures; the app always provides it.
    @Optional() private readonly impersonation?: ImpersonationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedPrincipal }>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw ApiException.unauthenticated('Authentication required');
    }

    const claims = this.tokenService.verifyAccessToken(header.slice('Bearer '.length));

    const state = await this.permVersions.getAuthState(claims.sub);
    if (state === null) {
      throw IdentityErrors.tokenInvalid();
    }
    if (state.permVersion !== claims.permVersion) {
      throw IdentityErrors.permissionsChanged();
    }
    if (claims.imp) {
      // A "view as" token: no service may honour it without this check (Work 85).
      if (!this.impersonation) {
        throw IdentityErrors.tokenInvalid();
      }
      await this.impersonation.checkRequest(claims, request.method, request.originalUrl ?? request.url);
    } else if (state.mfaRequired && claims.mfa !== true) {
      throw IdentityErrors.mfaRequired();
    }

    request.user = {
      userId: claims.sub,
      permissions: claims.permissions,
    };
    return true;
  }
}
