import { Inject, Injectable } from '@nestjs/common';
import { AdminMfaAuditor } from '../services/admin-mfa-auditor.service';
import { IdentityErrors } from '../../domain/errors';
import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
} from '../../domain/mfa/totp';
import { ADMIN_MFA_REPOSITORY, IAdminMfaRepository } from '../../domain/repositories/admin-mfa.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { IMfaSecretCipher, MFA_SECRET_CIPHER } from '../ports/mfa-secret-cipher.port';
import {
  AdminMfaChallengeService,
  ChallengeRequestContext,
  MFA_CHALLENGE_MAX_ATTEMPTS,
} from '../services/admin-mfa-challenge.service';

export const MFA_ISSUER = 'PharmaLink';

export interface StartMfaEnrollmentInput extends ChallengeRequestContext {
  challengeToken: string;
}

/**
 * The provisioning details for an authenticator app. Returned once, in this response only: the
 * secret is never logged, audited or returned again.
 */
export interface MfaEnrollmentView {
  secret: string;
  otpauthUri: string;
  issuer: string;
  accountName: string;
  algorithm: typeof TOTP_ALGORITHM;
  digits: number;
  period: number;
  expiresAt: Date;
}

/**
 * Step 1 of authenticator enrolment (Work 66): generates a fresh 160-bit TOTP secret for an ENROLL
 * challenge and stores it, encrypted, on the challenge until a valid code confirms it. Calling it
 * again on the same challenge replaces the pending secret (e.g. the user lost the first QR code);
 * it never extends the challenge.
 */
@Injectable()
export class StartMfaEnrollmentCommand {
  constructor(
    @Inject(ADMIN_MFA_REPOSITORY) private readonly repository: IAdminMfaRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(MFA_SECRET_CIPHER) private readonly cipher: IMfaSecretCipher,
    private readonly challenges: AdminMfaChallengeService,
    private readonly audit: AdminMfaAuditor,
  ) {}

  async execute(input: StartMfaEnrollmentInput): Promise<MfaEnrollmentView> {
    const challenge = await this.challenges.resolve(input.challengeToken, 'ENROLL');
    const user = await this.users.findById(challenge.userId);
    if (!user) {
      throw IdentityErrors.mfaChallengeInvalid();
    }
    user.assertCanAuthenticate();

    const secret = generateTotpSecret();
    const stored = await this.repository.setPendingSecret(
      challenge.id,
      this.cipher.encrypt(secret, user.id),
      new Date(),
      MFA_CHALLENGE_MAX_ATTEMPTS,
    );
    if (!stored) {
      throw IdentityErrors.mfaChallengeInvalid();
    }

    await this.audit.record({
      actorUserId: user.id,
      action: 'identity.mfa.enrollment_started',
      resourceType: 'user',
      resourceId: user.id,
      context: { replacement: challenge.replacesCredential },
      ip: input.ip ?? null,
    });

    const secretBase32 = base32Encode(secret);
    const accountName = user.email ?? user.phone ?? user.id;
    return {
      secret: secretBase32,
      otpauthUri: buildOtpauthUri({ issuer: MFA_ISSUER, account: accountName, secretBase32 }),
      issuer: MFA_ISSUER,
      accountName,
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      expiresAt: challenge.expiresAt,
    };
  }
}
