import { Inject, Injectable } from '@nestjs/common';
import {
  IPermVersionStore,
  PERM_VERSION_STORE,
} from '../../../identity/application/ports/perm-version.port';
import { ITokenService, TOKEN_SERVICE } from '../../../identity/application/ports/token.service';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';

/** The handshake shape a socket presents. Only the two places a token may legitimately arrive. */
export interface WsHandshake {
  auth?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}

/**
 * Authentication for WebSocket connections — the HTTP `JwtAuthGuard`'s three checks, performed
 * against a socket handshake instead of a request (module-01 §8, §12).
 *
 * ## Why this exists rather than reusing the guard
 *
 * `JwtAuthGuard` reads `context.switchToHttp().getRequest()` and an `Authorization` header off an
 * Express request; a socket handshake is neither. What must not differ is the *decision*, so this
 * performs the identical three checks in the identical order, against the identical ports:
 *
 *  1. the access token verifies (`ITokenService.verifyAccessToken`);
 *  2. the subject still has a known permission version (`IPermVersionStore`);
 *  3. that version matches the one the token was minted with.
 *
 * Step 3 is the one it would be easy to leave out and the one that matters most here. Access
 * tokens carry a snapshot of their holder's permissions, so a revoked role stays effective until
 * the token expires unless the version is compared. A WebSocket makes that worse than it is over
 * HTTP: an HTTP token stops working at its next request, whereas a socket authenticated once at
 * connect could otherwise stream a customer's delivery for as long as it stayed open. Connections
 * are therefore authenticated at connect **and** every privileged message re-checks authorization
 * against current data — see `TrackingGateway`.
 *
 * If Module 01 ever adds a fourth check to the HTTP guard, it belongs here too; the ports are
 * shared precisely so that the two cannot drift on anything but plumbing.
 */
@Injectable()
export class WsAuthService {
  constructor(
    @Inject(TOKEN_SERVICE) private readonly tokens: ITokenService,
    @Inject(PERM_VERSION_STORE) private readonly permVersions: IPermVersionStore,
  ) {}

  /**
   * Authenticates a handshake, or returns `null`.
   *
   * Returns rather than throws because the caller's only remedy is to close the socket, and a
   * thrown exception inside a connection handler is far more likely to escape into an unhandled
   * rejection than a null is to be ignored. The reason is deliberately not reported to the client
   * beyond "unauthenticated": distinguishing "your token is malformed" from "your permissions
   * changed" tells an attacker which half of a guess was right.
   */
  async authenticate(handshake: WsHandshake | undefined): Promise<AuthenticatedPrincipal | null> {
    const token = extractToken(handshake);
    if (token === null) {
      return null;
    }

    try {
      const claims = this.tokens.verifyAccessToken(token);
      const currentVersion = await this.permVersions.getCurrent(claims.sub);
      if (currentVersion === null || currentVersion !== claims.permVersion) {
        return null;
      }
      return { userId: claims.sub, permissions: claims.permissions };
    } catch {
      // `verifyAccessToken` throws on anything malformed or expired.
      return null;
    }
  }

  /**
   * Whether a principal holds a permission.
   *
   * Uses the same `hasPermission` matcher the HTTP `PermissionsGuard` uses, so a wildcard grant
   * behaves identically on a socket and on a route. A principal with no permissions array is
   * refused rather than waved through — an absent claim is not an empty requirement.
   */
  can(principal: AuthenticatedPrincipal, permission: string): boolean {
    return hasPermission(principal.permissions ?? [], permission);
  }
}

/**
 * Pulls a bearer token out of a handshake.
 *
 * Two accepted positions, in priority order. `auth.token` is the socket.io-native channel and the
 * one a browser client can actually set — a `WebSocket` handshake in a browser cannot carry custom
 * headers, so requiring `Authorization` would make the customer app the one client unable to
 * connect. The header form is still accepted for non-browser clients and for parity with HTTP.
 *
 * Neither is read from a query string, deliberately: query parameters are logged by proxies and
 * load balancers as a matter of routine, and an access token in a log file outlives the session it
 * came from.
 */
function extractToken(handshake: WsHandshake | undefined): string | null {
  const fromAuth = handshake?.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.trim().length > 0) {
    return stripBearer(fromAuth.trim());
  }

  const header = handshake?.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }

  return null;
}

function stripBearer(value: string): string {
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : value;
}
