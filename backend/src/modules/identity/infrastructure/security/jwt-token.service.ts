import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { IdentityErrors } from '../../domain/errors';
import {
  AccessTokenClaims,
  AccessTokenResult,
  ITokenService,
  RefreshTokenResult,
} from '../../application/ports/token.service';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

interface JwtPayload extends AccessTokenClaims {
  iat: number;
  exp: number;
}

/**
 * Dependency-free JWT (HS256) access-token issuer + opaque refresh-token minter (module-01 §8).
 * The design doc specifies RS256 for multi-service verification; HS256 with a shared secret is
 * the pragmatic choice for a single-process modular monolith and can be swapped for an
 * asymmetric adapter behind the same ITokenService port when Identity is extracted.
 */
@Injectable()
export class JwtTokenService implements ITokenService {
  constructor(private readonly config: AppConfigService) {}

  issueAccessToken(claims: AccessTokenClaims, ttlSeconds: number): AccessTokenResult {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSeconds;
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload: JwtPayload = { ...claims, jti: claims.jti ?? randomUUID(), iat: now, exp };

    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const signature = this.sign(`${encodedHeader}.${encodedPayload}`, this.config.jwtAccessSecret);

    return { token: `${encodedHeader}.${encodedPayload}.${signature}`, expiresAt: exp };
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw IdentityErrors.tokenInvalid();
    }
    const [encodedHeader, encodedPayload, signature] = parts;
    const expectedSignature = this.sign(
      `${encodedHeader}.${encodedPayload}`,
      this.config.jwtAccessSecret,
    );
    if (!this.safeEqual(signature, expectedSignature)) {
      throw IdentityErrors.tokenInvalid();
    }

    let payload: JwtPayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      throw IdentityErrors.tokenInvalid();
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw IdentityErrors.tokenInvalid();
    }

    return payload;
  }

  async createRefreshToken(): Promise<RefreshTokenResult> {
    const token = randomBytes(32).toString('hex');
    return {
      token,
      tokenHash: this.hashRefreshToken(token),
      familyId: randomUUID(),
    };
  }

  hashRefreshToken(token: string): string {
    return this.sign(token, this.config.jwtRefreshSecret);
  }

  private sign(data: string, secret: string): string {
    return createHmac('sha256', secret).update(data).digest('base64url');
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}
