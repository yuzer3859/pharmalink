import { Inject, Injectable } from '@nestjs/common';
import { OtpPurpose } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { normalizeIdentifier } from '../../domain/value-objects/identifier';
import { INotificationPort, NOTIFICATION_PORT, NotificationUndeliverableError } from '../ports/notification.port';
import { IOtpService, OTP_SERVICE } from '../ports/otp.service';

export interface ResendOtpInput {
  identifier: string;
  purpose: OtpPurpose;
}

export interface ResendOtpOutput {
  resent: true;
  /** Seconds before another code may be requested for this identifier and purpose. */
  cooldownSeconds: number;
}

/**
 * Resend OTP use case (module-01 §3.2 F-VER-05, §11.1). The cooldown is enforced by the OTP store
 * itself, atomically and across instances: while it runs, nothing is issued or sent and the
 * request fails with 429 `RATE_LIMITED` (`details.retryAfterSeconds`).
 *
 * Delivery (Work 62) is truthful: success means the provider accepted the message.
 * - A channel with no provider (SMS today, e-mail without Resend) fails with 503
 *   `DEPENDENCY_UNAVAILABLE` *before* a code is issued, so no cooldown starts.
 * - A send that fails after the code was issued also fails with 503, with
 *   `details.retryAfterSeconds`: the undelivered code stays in the store until it expires or is
 *   replaced, and the cooldown that started with it still applies. Retrying after it issues a new
 *   code, which replaces the undelivered one.
 */
@Injectable()
export class ResendOtpCommand {
  constructor(
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: INotificationPort,
  ) {}

  async execute(input: ResendOtpInput): Promise<ResendOtpOutput> {
    // Normalized so the reissued OTP is keyed identically to the one the caller is replacing.
    const identifier = normalizeIdentifier(input.identifier);
    if (!identifier) {
      throw IdentityErrors.validation('Provide a valid phone number or email address.', {
        field: 'identifier',
      });
    }

    if (!this.notifications.canDeliver(identifier.channel)) {
      throw IdentityErrors.deliveryUnavailable(identifier.channel, 'NOT_CONFIGURED');
    }

    const issued = await this.otp.issue(identifier.value, input.purpose);
    if (issued.status === 'COOLDOWN') {
      throw IdentityErrors.otpCooldown(issued.retryAfterSeconds);
    }
    try {
      await this.notifications.send({
        channel: identifier.channel,
        to: identifier.value,
        template: `otp-${input.purpose.toLowerCase()}`,
        data: { code: issued.code },
      });
    } catch (err) {
      if (err instanceof NotificationUndeliverableError) {
        throw IdentityErrors.deliveryUnavailable(err.channel, err.reason, issued.cooldownSeconds);
      }
      throw err;
    }
    return { resent: true, cooldownSeconds: issued.cooldownSeconds };
  }
}
