import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { PERMISSION_RESOLVER, IPermissionResolver } from '../../../../shared/rbac/rbac.types';
import { IdentityErrors } from '../../domain/errors';
import { refreshReuseDetectedEvent } from '../../domain/events';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import {
  IRefreshTokenRepository,
  REFRESH_TOKEN_REPOSITORY,
} from '../../domain/repositories/auth.repositories';
import { AdminMfaAuditor } from '../services/admin-mfa-auditor.service';
import { AccessTokenResult, ITokenService, TOKEN_SERVICE } from '../ports/token.service';
import { AdminMfaPolicy } from '../services/admin-mfa-policy.service';

export interface RefreshTokenInput {
  refreshToken: string;
}

export interface RefreshTokenOutput {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * Token-refresh use case (module-01 §7.5, §11.2, §13.5). Rotating, one-time-use refresh tokens
 * with reuse detection: presenting an already-used/revoked token revokes the whole rotation
 * family and signals theft.
 *
 * Administrator MFA (Work 66): the family's MFA assurance (`mfaVerifiedAt`) is copied to every
 * rotated token. A platform administrator whose family has none (any token from before Work 66,
 * from before a promotion to ADMIN/SUPER_ADMIN, or otherwise issued without MFA) is refused with
 * `AUTH_MFA_REQUIRED` and the family revoked. Whether the account is an administrator is read now,
 * not from when the family began.
 */
@Injectable()
export class RefreshTokenCommand {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: IRefreshTokenRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(TOKEN_SERVICE) private readonly tokenService: ITokenService,
    @Inject(PERMISSION_RESOLVER) private readonly permissionResolver: IPermissionResolver,
    private readonly config: AppConfigService,
    private readonly outbox: OutboxService,
    private readonly mfaPolicy: AdminMfaPolicy,
    private readonly audit: AdminMfaAuditor,
  ) {}

  async execute(input: RefreshTokenInput): Promise<RefreshTokenOutput> {
    const tokenHash = this.tokenService.hashRefreshToken(input.refreshToken);

    const record = await this.refreshTokens.findByHash(tokenHash);
    if (!record) {
      throw IdentityErrors.refreshInvalid();
    }

    if (record.usedAt || record.revokedAt) {
      await this.refreshTokens.revokeFamily(record.familyId);
      await this.outbox.write(
        refreshReuseDetectedEvent({ userId: record.userId, familyId: record.familyId }),
      );
      throw IdentityErrors.refreshReuseDetected();
    }

    if (record.expiresAt.getTime() < Date.now()) {
      throw IdentityErrors.refreshInvalid();
    }

    const user = await this.users.findById(record.userId);
    if (!user) {
      throw IdentityErrors.refreshInvalid();
    }
    user.assertCanAuthenticate();

    if (!record.mfaVerifiedAt && (await this.mfaPolicy.requiresMfa(user.id))) {
      await this.refreshTokens.revokeFamily(record.familyId);
      await this.audit.record({
        actorUserId: user.id,
        action: 'identity.mfa.privileged_session_blocked',
        resourceType: 'user',
        resourceId: user.id,
        context: { path: 'REFRESH', familyId: record.familyId },
      });
      throw IdentityErrors.mfaRequired();
    }

    const refreshTtlMs = this.config.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
    const newExpiresAt = new Date(Date.now() + refreshTtlMs);
    const issuedRefresh = await this.tokenService.createRefreshToken();

    const newRecord = await this.refreshTokens.create({
      userId: user.id,
      deviceId: record.deviceId,
      tokenHash: issuedRefresh.tokenHash,
      familyId: record.familyId,
      expiresAt: newExpiresAt,
      mfaVerifiedAt: record.mfaVerifiedAt,
    });
    await this.refreshTokens.markUsed(record.id, newRecord.id);

    const permissions = await this.permissionResolver.resolvePermissions(user.id);
    const access: AccessTokenResult = this.tokenService.issueAccessToken(
      {
        sub: user.id,
        permissions,
        permVersion: user.permVersion,
        deviceId: record.deviceId ?? undefined,
        ...(record.mfaVerifiedAt ? { mfa: true as const } : {}),
      },
      this.config.accessTokenTtlSeconds,
    );

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: issuedRefresh.token,
      refreshTokenExpiresAt: newExpiresAt,
    };
  }
}
