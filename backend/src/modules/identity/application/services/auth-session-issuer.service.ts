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
import { ITokenService, TOKEN_SERVICE } from '../ports/token.service';

export interface IssueSessionInput {
  user: User;
  deviceInfo: DeviceInfo;
  ip: string | null;
  userAgent: string | null;
}

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * Shared session-issuance building block used by LoginUser and the OTP auto-login path
 * (module-01 §7.1 step 4, §13.2). Registers/looks up the device, opens a session, mints a
 * device-bound refresh token, and signs an access token carrying the effective permission set.
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
  ) {}

  async issue(input: IssueSessionInput): Promise<IssuedSession> {
    const device = await this.devices.upsertForUser(input.user.id, input.deviceInfo);

    const refreshTtlMs = this.config.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
    const refreshExpiresAt = new Date(Date.now() + refreshTtlMs);

    await this.sessions.create({
      userId: input.user.id,
      deviceId: device.id,
      ip: input.ip,
      userAgent: input.userAgent,
      expiresAt: refreshExpiresAt,
    });

    const issuedRefresh = await this.tokenService.createRefreshToken();
    await this.refreshTokens.create({
      userId: input.user.id,
      deviceId: device.id,
      tokenHash: issuedRefresh.tokenHash,
      familyId: issuedRefresh.familyId,
      expiresAt: refreshExpiresAt,
    });

    const permissions = await this.permissionResolver.resolvePermissions(input.user.id);
    const access = this.tokenService.issueAccessToken(
      {
        sub: input.user.id,
        permissions,
        permVersion: input.user.permVersion,
        deviceId: device.id,
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
