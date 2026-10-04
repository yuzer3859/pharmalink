export const TOKEN_SERVICE = Symbol('TOKEN_SERVICE');

/**
 * Access/refresh token issuance port (module-01 §7, §7.5). Stateless JWT access tokens for
 * horizontal scaling; opaque rotating refresh tokens to keep revocation possible.
 */
export interface AccessTokenClaims {
  sub: string;
  /** Flat effective permissions for this session. */
  permissions: string[];
  permVersion: number;
  deviceId?: string;
  sessionId?: string;
  /** JWT ID for token rotation/denylist if ever needed. */
  jti?: string;
}

export interface AccessTokenResult {
  token: string;
  /** Numeric expiration (Unix epoch seconds). */
  expiresAt: number;
}

export interface RefreshTokenResult {
  /** Unhashed, plaintext refresh token to return once. */
  token: string;
  tokenHash: string;
  familyId: string;
}

export interface ITokenService {
  /** Signs a short-lived access token. */
  issueAccessToken(claims: AccessTokenClaims, ttlSeconds: number): AccessTokenResult;
  /** Verifies an access token; throws AUTH_TOKEN_INVALID if malformed/expired. */
  verifyAccessToken(token: string): AccessTokenClaims;
  /** Creates a one-time opaque refresh token and returns both the plaintext and its hash. */
  createRefreshToken(): Promise<RefreshTokenResult>;
  /** Deterministically hashes a presented plaintext refresh token for repository lookup. */
  hashRefreshToken(token: string): string;
}
