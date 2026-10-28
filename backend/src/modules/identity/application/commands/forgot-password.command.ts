import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OtpPurpose } from '../../domain/enums';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { normalizeIdentifier } from '../../domain/value-objects/identifier';
import { INotificationPort, NOTIFICATION_PORT } from '../ports/notification.port';
import { IOtpService, OTP_SERVICE, OtpIssueOutcome } from '../ports/otp.service';

export interface ForgotPasswordInput {
  identifier: string;
  ip?: string | null;
}

export interface ForgotPasswordOutput {
  challengeSent: true;
}

/**
 * POST /auth/password/forgot (module-01 §3.4, §11.3, §13.3). Always reports success: a different
 * response for a known vs unknown identifier would turn this endpoint into a user-enumeration
 * oracle. A malformed identifier is treated the same way, for the same reason.
 *
 * For the same reason, a known account whose reset code cannot be issued — a code was sent within
 * the resend cooldown, or the OTP store is unavailable — also gets the generic success. Nothing is
 * issued or sent in either case, so no reset can complete (fail closed); only the response is
 * uniform. An unavailable store is logged without the identifier.
 */
@Injectable()
export class ForgotPasswordCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: INotificationPort,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(ForgotPasswordCommand.name);
  }

  async execute(input: ForgotPasswordInput): Promise<ForgotPasswordOutput> {
    const identifier = normalizeIdentifier(input.identifier);
    if (!identifier) {
      return { challengeSent: true };
    }

    const user = await this.users.findByIdentifier(identifier.value);

    // Audit the attempt either way — a burst against unknown identifiers is itself a signal.
    await this.audit.record({
      actorUserId: user?.id ?? null,
      action: 'identity.password.reset_requested',
      resourceType: 'user',
      resourceId: user?.id ?? null,
      context: { identifier: identifier.masked, known: user !== null },
      ip: input.ip ?? null,
    });

    if (!user) {
      return { challengeSent: true };
    }

    let issued: OtpIssueOutcome;
    try {
      issued = await this.otp.issue(identifier.value, OtpPurpose.RESET);
    } catch (err) {
      if (err instanceof ApiException && err.code === ErrorCode.DEPENDENCY_UNAVAILABLE) {
        this.logger.warn('Password reset code not issued: the OTP store is unavailable.');
        return { challengeSent: true };
      }
      throw err;
    }
    if (issued.status === 'COOLDOWN') {
      return { challengeSent: true };
    }
    await this.notifications.send({
      channel: identifier.channel,
      to: identifier.value,
      template: 'otp-reset',
      data: { code: issued.code },
    });

    return { challengeSent: true };
  }
}
