import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OtpPurpose } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { normalizeIdentifier } from '../../domain/value-objects/identifier';
import { PasswordPolicy } from '../../domain/value-objects/password-policy';
import { HASHER, IHasher } from '../ports/hasher.port';
import { INotificationPort, NOTIFICATION_PORT } from '../ports/notification.port';
import { IOtpService, OTP_SERVICE, OtpVerifyResult } from '../ports/otp.service';
import { PermissionChangeService } from '../services/permission-change.service';
import { LogoutAllCommand } from './logout.command';

export interface ResetPasswordInput {
  identifier: string;
  code: string;
  newPassword: string;
  ip?: string | null;
}

export interface ResetPasswordOutput {
  reset: true;
}

/**
 * POST /auth/password/reset (module-01 §7.7, §11.3, §13.3). Order matters and follows §13.3:
 * prove possession of the OTP first, then validate the new password, then rotate the credential
 * and kill every session. An unknown identifier that somehow passes OTP verification is reported
 * as an invalid code, never as "no such user".
 */
@Injectable()
export class ResetPasswordCommand {
  private readonly passwordPolicy = new PasswordPolicy();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    @Inject(HASHER) private readonly hasher: IHasher,
    @Inject(NOTIFICATION_PORT) private readonly notifications: INotificationPort,
    private readonly logoutAll: LogoutAllCommand,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ResetPasswordInput): Promise<ResetPasswordOutput> {
    const identifier = normalizeIdentifier(input.identifier);
    if (!identifier) {
      throw IdentityErrors.otpInvalid();
    }

    const result = await this.otp.verify(identifier.value, OtpPurpose.RESET, input.code);
    switch (result) {
      case OtpVerifyResult.INVALID:
        throw IdentityErrors.otpInvalid();
      case OtpVerifyResult.EXPIRED:
        throw IdentityErrors.otpExpired();
      case OtpVerifyResult.ATTEMPTS_EXCEEDED:
        throw IdentityErrors.otpAttemptsExceeded();
      case OtpVerifyResult.OK:
        break;
    }

    this.passwordPolicy.assert(input.newPassword);

    const user = await this.users.findByIdentifier(identifier.value);
    if (!user) {
      throw IdentityErrors.otpInvalid();
    }

    user.changePassword(await this.hasher.hash(input.newPassword));
    await this.users.save(user);

    // Revoke refresh tokens + sessions, then bump permVersion so live access tokens are rejected
    // immediately rather than lingering for the remainder of their TTL.
    await this.logoutAll.execute(user.id, 'PASSWORD_RESET');
    await this.permissionChange.propagate([user.id]);

    await this.notifications.send({
      channel: identifier.channel,
      to: identifier.value,
      template: 'security-password-reset',
      data: { at: new Date().toISOString() },
    });

    await this.audit.record({
      actorUserId: user.id,
      action: 'identity.password.reset',
      resourceType: 'user',
      resourceId: user.id,
      context: { identifier: identifier.masked },
      ip: input.ip ?? null,
    });

    return { reset: true };
  }
}
