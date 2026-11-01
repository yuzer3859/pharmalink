import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { PERMISSION_RESOLVER, IPermissionResolver } from '../../../../shared/rbac/rbac.types';
import { User } from '../../domain/entities/user.entity';
import {
  DEVICE_REPOSITORY,
  DeviceInfo,
  IDeviceRepository,
  IRefreshTokenRepository,
  ISessionRepository,
  REFRESH_TOKEN_REPOSITORY,
  SESSION_REPOSITORY,
} from '../../domain/repositories/auth.repositories';
import { IdentityErrors } from '../../domain/errors';
import { ITokenService, TOKEN_SERVICE } from '../ports/token.service';
import { AdminMfaPolicy } from './admin-mfa-policy.service';

export interface IssueSessionInput {
  user: User;
  deviceInfo: DeviceInfo;
  ip: string | null;
  userAgent: string | null;
  /**
   * When administrator MFA was completed for this sign-in (Work 66). Set only by the MFA commands.
   * A platform administrator without it gets no session.
   */
  mfaVerifiedAt?: Date | null;
}

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * Shared session-issuance building block used by LoginUser, the OTP auto-login path and the
 * administrator MFA commands (module-01 §7.1 step 4, §13.2). Registers/looks up the device, opens
 * a session, mints a device-bound refresh token, and signs an access token carrying the effective
 * permission set.
 *
 * It is also the last line of administrator MFA (Work 66): it refuses to issue anything to a
 * platform administrator unless the caller supplies `mfaVerifiedAt`, whatever path called it. The
 * assurance is stored on the session and the refresh-token family and carried in the access token
 * (`mfa: true`), which is what `RefreshTokenCommand` and `JwtAuthGuard` check.
 */
@Injectable()
export class AuthSessionIssuerService {
  constructor(
    @Inject(DEVICE_REPOSITORY) private readonly devices: IDeviceRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: ISessionRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: IRefreshTokenRepository,
    @Inject(TOKEN_SERVICE) private readonly tokenService: ITokenService,
    @Inject(PERMISSION_RESOLVER) private readonly permissionResolver: IPermissionResolver,
    private readonly config: AppConfigService,
    private readonly mfaPolicy: AdminMfaPolicy,
  ) {}

  async issue(input: IssueSessionInput): Promise<IssuedSession> {
    const mfaVerifiedAt = input.mfaVerifiedAt ?? null;
    if (!mfaVerifiedAt && (await this.mfaPolicy.requiresMfa(input.user.id))) {
      throw IdentityErrors.mfaRequired();
    }

    const device = await this.devices.upsertForUser(input.user.id, input.deviceInfo);

    const refreshTtlMs = this.config.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
    const refreshExpiresAt = new Date(Date.now() + refreshTtlMs);

    await this.sessions.create({
      userId: input.user.id,
      deviceId: device.id,
      ip: input.ip,
      userAgent: input.userAgent,
      expiresAt: refreshExpiresAt,
      mfaVerifiedAt,
    });

    const issuedRefresh = await this.tokenService.createRefreshToken();
    await this.refreshTokens.create({
      userId: input.user.id,
      deviceId: device.id,
      tokenHash: issuedRefresh.tokenHash,
      familyId: issuedRefresh.familyId,
      expiresAt: refreshExpiresAt,
      mfaVerifiedAt,
    });

    const permissions = await this.permissionResolver.resolvePermissions(input.user.id);
    const access = this.tokenService.issueAccessToken(
      {
        sub: input.user.id,
        permissions,
        permVersion: input.user.permVersion,
        deviceId: device.id,
        ...(mfaVerifiedAt ? { mfa: true as const } : {}),
      },
      this.config.accessTokenTtlSeconds,
    );

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: issuedRefresh.token,
      refreshTokenExpiresAt: refreshExpiresAt,
    };
  }
}
