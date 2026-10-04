import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { OtpPurpose } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { userVerifiedEvent } from '../../domain/events';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { DeviceInfo } from '../../domain/repositories/auth.repositories';
import { normalizeIdentifier } from '../../domain/value-objects/identifier';
import { IOtpService, OTP_SERVICE, OtpVerifyResult } from '../ports/otp.service';
import { AuthSessionIssuerService, IssuedSession } from '../services/auth-session-issuer.service';

export interface VerifyOtpInput {
  identifier: string;
  code: string;
  purpose: OtpPurpose;
  /** Optional — when present on REGISTER/LOGIN, the verified user is auto-logged-in (module-01
   * §13.4). Omit for a bare verification (e.g. STEP_UP, RESET continues its own flow). */
  deviceInfo?: DeviceInfo;
  ip?: string | null;
  userAgent?: string | null;
}

export interface VerifyOtpOutput {
  verified: true;
  tokens?: IssuedSession;
}

/** OTP verification use case (module-01 §3.2, §11.1, §13.4). */
@Injectable()
export class VerifyOtpCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    private readonly outbox: OutboxService,
    private readonly sessionIssuer: AuthSessionIssuerService,
  ) {}

  async execute(input: VerifyOtpInput): Promise<VerifyOtpOutput> {
    // OTPs are keyed by the canonical identifier the OTP was issued for (the stored E.164
    // phone / lowercased email), so the user's raw input must be normalized to match.
    const identifier = normalizeIdentifier(input.identifier);
    if (!identifier) {
      throw IdentityErrors.otpInvalid();
    }

    const result = await this.otp.verify(identifier.value, input.purpose, input.code);
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

    const user = await this.users.findByIdentifier(identifier.value);
    if (!user) {
      throw IdentityErrors.otpInvalid();
    }

    const isEmail = identifier.channel === 'EMAIL';
    if (isEmail) {
      user.markEmailVerified();
    } else {
      user.markPhoneVerified();
    }
    await this.users.save(user);

    await this.outbox.write(
      userVerifiedEvent({ userId: user.id, method: isEmail ? 'EMAIL' : 'PHONE' }),
    );

    const autoLogin =
      (input.purpose === OtpPurpose.REGISTER || input.purpose === OtpPurpose.LOGIN) &&
      input.deviceInfo;

    if (!autoLogin) {
      return { verified: true };
    }

    const tokens = await this.sessionIssuer.issue({
      user,
      deviceInfo: input.deviceInfo as DeviceInfo,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });

    return { verified: true, tokens };
  }
}
