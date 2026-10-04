import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { sessionsRevokedEvent } from '../../domain/events';
import {
  IRefreshTokenRepository,
  ISessionRepository,
  REFRESH_TOKEN_REPOSITORY,
  SESSION_REPOSITORY,
} from '../../domain/repositories/auth.repositories';
import { ITokenService, TOKEN_SERVICE } from '../ports/token.service';

/**
 * Logout (single device) — revokes the presented refresh-token family; the short-lived access
 * token is left to expire naturally (module-01 §7.6).
 */
@Injectable()
export class LogoutCommand {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: IRefreshTokenRepository,
    @Inject(TOKEN_SERVICE) private readonly tokenService: ITokenService,
  ) {}

  async execute(refreshToken: string): Promise<void> {
    const tokenHash = this.tokenService.hashRefreshToken(refreshToken);
    const record = await this.refreshTokens.findByHash(tokenHash);
    if (record) {
      await this.refreshTokens.revokeFamily(record.familyId);
    }
  }
}

/** Logout-all — revokes every refresh token and session for the user (module-01 §7.6). */
@Injectable()
export class LogoutAllCommand {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: IRefreshTokenRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: ISessionRepository,
    private readonly outbox: OutboxService,
  ) {}

  async execute(userId: string, reason = 'LOGOUT_ALL'): Promise<void> {
    await this.refreshTokens.revokeAllForUser(userId);
    await this.sessions.revokeAllForUser(userId);
    await this.outbox.write(sessionsRevokedEvent({ userId, reason }));
  }
}
