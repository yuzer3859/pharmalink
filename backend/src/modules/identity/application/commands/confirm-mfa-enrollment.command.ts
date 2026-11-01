import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { IdentityErrors } from '../../domain/errors';
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from '../../domain/mfa/recovery-codes';
import { matchTotp } from '../../domain/mfa/totp';
import { ADMIN_MFA_REPOSITORY, IAdminMfaRepository } from '../../domain/repositories/admin-mfa.repository';
import {
  DeviceInfo,
  IRefreshTokenRepository,
  ISessionRepository,
  REFRESH_TOKEN_REPOSITORY,
  SESSION_REPOSITORY,
} from '../../domain/repositories/auth.repositories';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { IMfaSecretCipher, MFA_SECRET_CIPHER } from '../ports/mfa-secret-cipher.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import {
  AdminMfaChallengeService,
  ChallengeRequestContext,
  MFA_CHALLENGE_MAX_ATTEMPTS,
} from '../services/admin-mfa-challenge.service';
import { IssuedSession } from '../services/auth-session-issuer.service';
import { PermissionChangeService } from '../services/permission-change.service';

export interface ConfirmMfaEnrollmentInput extends ChallengeRequestContext {
  challengeToken: string;
  code: string;
  deviceInfo: DeviceInfo;
}

export interface ConfirmMfaEnrollmentOutput extends IssuedSession {
  /** Shown once. Only their hashes are stored. */
  recoveryCodes: string[];
}

/**
 * Step 2 of authenticator enrolment (Work 66). A valid code for the pending secret proves the
 * authenticator works; then, in one Serializable transaction, the challenge is consumed, the
 * credential is created (or, after a recovery code, replaces the old authenticator), the accepted
 * time step is recorded (so the same code can't sign in again) and a fresh set of recovery codes
 * replaces any old ones. Only then is an MFA-verified session issued.
 *
 * Replacing an authenticator also revokes every existing session and refresh token of the account
 * and bumps its permission version, so nothing signed in with the old authenticator survives.
 */
@Injectable()
export class ConfirmMfaEnrollmentCommand {
  constructor(
    @Inject(ADMIN_MFA_REPOSITORY) private readonly repository: IAdminMfaRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: IRefreshTokenRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: ISessionRepository,
    @Inject(MFA_SECRET_CIPHER) private readonly cipher: IMfaSecretCipher,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly challenges: AdminMfaChallengeService,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ConfirmMfaEnrollmentInput): Promise<ConfirmMfaEnrollmentOutput> {
    const challenge = await this.challenges.resolve(input.challengeToken, 'ENROLL');
    if (!challenge.encryptedPendingSecret) {
      // Enrolment was never started on this challenge.
      throw IdentityErrors.mfaChallengeInvalid();
    }
    const user = await this.users.findById(challenge.userId);
    if (!user) {
      throw IdentityErrors.mfaChallengeInvalid();
    }
    user.assertCanAuthenticate();

    const secret = this.cipher.decrypt(challenge.encryptedPendingSecret, user.id);
    const step = matchTotp(secret, input.code, Date.now());
    if (step === null) {
      return this.challenges.rejectCode(challenge, user, 'ENROLL', 'CODE_MISMATCH', input);
    }

    const recoveryCodes = generateRecoveryCodes();
    const codeHashes = recoveryCodes.map((code) => hashRecoveryCode(normalizeRecoveryCode(code)!));
    const replacement = challenge.replacesCredential;

    try {
      await this.uow.run(
        async (tx) => {
          const now = new Date();
          if (!(await this.repository.consumeChallenge(challenge.id, now, MFA_CHALLENGE_MAX_ATTEMPTS, tx))) {
            throw IdentityErrors.mfaChallengeInvalid();
          }
          const encrypted = this.cipher.encrypt(secret, user.id);
          if (replacement) {
            await this.repository.replaceCredential(user.id, encrypted, step, tx);
            await this.refreshTokens.revokeAllForUser(user.id, tx);
            await this.sessions.revokeAllForUser(user.id, tx);
          } else {
            // Unique per user: a concurrent enrolment through another challenge loses here.
            await this.repository.createCredential(user.id, encrypted, step, tx);
          }
          await this.repository.replaceRecoveryCodes(user.id, codeHashes, tx);
          await this.audit.record(
            {
              actorUserId: user.id,
              action: 'identity.mfa.enrollment_completed',
              resourceType: 'user',
              resourceId: user.id,
              context: { replacement, recoveryCodes: codeHashes.length },
              ip: input.ip ?? null,
            },
            tx,
          );
          if (replacement) {
            await this.audit.record(
              {
                actorUserId: user.id,
                action: 'identity.mfa.authenticator_replaced',
                resourceType: 'user',
                resourceId: user.id,
                context: { sessionsRevoked: true },
                ip: input.ip ?? null,
              },
              tx,
            );
          }
        },
        { isolation: 'serializable' },
      );
    } catch (err) {
      if (err instanceof ApiException) throw err;
      // A concurrent first enrolment (through another challenge) created the credential first and
      // this one hit the unique key: it can't finish. Anything else is a real failure.
      if (!replacement && (await this.repository.findCredential(user.id))) {
        throw IdentityErrors.mfaChallengeInvalid();
      }
      return this.challenges.rethrowUnlessGone(input.challengeToken, 'ENROLL', err);
    }

    let current = user;
    if (replacement) {
      // Access tokens minted with the old authenticator stop working now.
      await this.permissionChange.propagate([user.id]);
      current = (await this.users.findById(user.id)) ?? user;
    }

    const session = await this.challenges.issueVerifiedSession(current, input.deviceInfo, input);
    return { ...session, recoveryCodes };
  }
}
