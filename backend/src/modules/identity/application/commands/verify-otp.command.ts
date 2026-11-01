import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { OtpPurpose } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { userVerifiedEvent } from '../../domain/events';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { DeviceInfo } from '../../domain/repositories/auth.repositories';
import { normalizeIdentifier } from '../../domain/value-objects/identifier';
import { AdminMfaAuditor } from '../services/admin-mfa-auditor.service';
import { IOtpService, OTP_SERVICE, OtpVerifyResult } from '../ports/otp.service';
import { AdminMfaPolicy } from '../services/admin-mfa-policy.service';
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
  /**
   * Work 66: the account is a platform administrator, so verifying the code issued no session. The
   * code still did its job (e.g. activated the account); the administrator signs in with their
   * password and completes authenticator MFA.
   */
  mfaRequired?: true;
}

/**
 * OTP verification use case (module-01 §3.2, §11.1, §13.4).
 *
 * A verified code proves control of a phone or inbox. For a platform administrator it is never a
 * sign-in factor (Work 66): REGISTER/LOGIN auto-login issues no session to them, which also covers
 * the first Super Admin's e-mail verification after the Work 65 bootstrap.
 */
@Injectable()
export class VerifyOtpCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    private readonly outbox: OutboxService,
    private readonly sessionIssuer: AuthSessionIssuerService,
    private readonly mfaPolicy: AdminMfaPolicy,
    private readonly audit: AdminMfaAuditor,
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

    if (await this.mfaPolicy.requiresMfa(user.id)) {
      await this.audit.record({
        actorUserId: user.id,
        action: 'identity.mfa.privileged_session_blocked',
        resourceType: 'user',
        resourceId: user.id,
        context: { path: 'OTP_AUTO_LOGIN', purpose: input.purpose },
        ip: input.ip ?? null,
      });
      return { verified: true, mfaRequired: true };
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
