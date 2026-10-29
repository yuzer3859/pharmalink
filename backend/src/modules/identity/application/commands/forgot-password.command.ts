import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OtpPurpose } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { normalizeIdentifier } from '../../domain/value-objects/identifier';
import { INotificationPort, NOTIFICATION_PORT, NotificationUndeliverableError } from '../ports/notification.port';
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
 *
 * Delivery (Work 62):
 * - A channel with no provider (SMS today; e-mail without Resend) fails with 503
 *   `DEPENDENCY_UNAVAILABLE` for every request on that channel, checked before the account
 *   lookup, so the answer is the same for known and unknown identifiers.
 * - A send to a known account that the provider doesn't accept is logged without the identifier
 *   and answered with the generic success. Reporting it would reveal that the account exists, and
 *   it would be triggerable on demand where the provider refuses some recipients (e.g. Resend's
 *   test mode). The user can ask again once the resend cooldown has passed.
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

    if (!this.notifications.canDeliver(identifier.channel)) {
      throw IdentityErrors.deliveryUnavailable(identifier.channel, 'NOT_CONFIGURED');
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
    try {
      await this.notifications.send({
        channel: identifier.channel,
        to: identifier.value,
        template: 'otp-reset',
        data: { code: issued.code },
      });
    } catch (err) {
      if (!(err instanceof NotificationUndeliverableError)) throw err;
      this.logger.warn(`Password reset code not delivered (${err.channel}, ${err.reason}).`);
    }

    return { challengeSent: true };
  }
}
