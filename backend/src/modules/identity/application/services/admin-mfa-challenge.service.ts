import { createHash, randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AdminMfaAuditor } from './admin-mfa-auditor.service';
import { User } from '../../domain/entities/user.entity';
import { LoginOutcome } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import {
  ADMIN_MFA_REPOSITORY,
  AdminMfaChallengePurpose,
  AdminMfaChallengeRecord,
  IAdminMfaRepository,
} from '../../domain/repositories/admin-mfa.repository';
import {
  DeviceInfo,
  ILoginHistoryRepository,
  LOGIN_HISTORY_REPOSITORY,
} from '../../domain/repositories/auth.repositories';
import { AuthSessionIssuerService, IssuedSession } from './auth-session-issuer.service';

/** About five minutes to finish the second factor after the password (Work 66). */
export const MFA_CHALLENGE_TTL_SECONDS = 300;
/** Failed codes allowed per challenge; the challenge is dead after this many. */
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

const CHALLENGE_TOKEN_BYTES = 32;

/**
 * What the client gets instead of a session when administrator MFA is required (Work 66).
 * `TOTP`: enter the authenticator code (or redeem a recovery code). `ENROLLMENT`: set up an
 * authenticator first; `reason: 'RECOVERY'` when it replaces one after a recovery code.
 */
export interface MfaChallengeView {
  mfaRequired: true;
  challenge: {
    type: 'TOTP' | 'ENROLLMENT';
    token: string;
    expiresAt: Date;
    reason?: 'RECOVERY';
  };
}

export interface ChallengeRequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Administrator MFA challenges (Work 66). A challenge is a 256-bit random bearer token returned
 * once; only its SHA-256 hash is stored, bound to one user and one purpose, valid for five minutes
 * and for at most five failed codes. It authorizes nothing but the MFA endpoints, and the account is
 * always taken from the challenge, never from the request.
 */
@Injectable()
export class AdminMfaChallengeService {
  constructor(
    @Inject(ADMIN_MFA_REPOSITORY) private readonly repository: IAdminMfaRepository,
    @Inject(LOGIN_HISTORY_REPOSITORY) private readonly loginHistory: ILoginHistoryRepository,
    private readonly sessionIssuer: AuthSessionIssuerService,
    private readonly audit: AdminMfaAuditor,
  ) {}

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issue(
    userId: string,
    purpose: AdminMfaChallengePurpose,
    options: { replacesCredential?: boolean; tx?: unknown } = {},
  ): Promise<MfaChallengeView> {
    const token = randomBytes(CHALLENGE_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000);
    const replacesCredential = purpose === 'ENROLL' && options.replacesCredential === true;
    await this.repository.createChallenge(
      { userId, tokenHash: AdminMfaChallengeService.hashToken(token), purpose, replacesCredential, expiresAt },
      options.tx,
    );
    return {
      mfaRequired: true,
      challenge: {
        type: purpose === 'ENROLL' ? 'ENROLLMENT' : 'TOTP',
        token,
        expiresAt,
        ...(replacesCredential ? { reason: 'RECOVERY' as const } : {}),
      },
    };
  }

  /** The usable challenge for `token` and `purpose`, or `AUTH_MFA_CHALLENGE_INVALID`. */
  async resolve(token: string, purpose: AdminMfaChallengePurpose): Promise<AdminMfaChallengeRecord> {
    const challenge = await this.repository.findChallengeByTokenHash(AdminMfaChallengeService.hashToken(token));
    if (
      !challenge ||
      challenge.purpose !== purpose ||
      challenge.consumedAt !== null ||
      challenge.expiresAt.getTime() <= Date.now() ||
      challenge.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS
    ) {
      throw IdentityErrors.mfaChallengeInvalid();
    }
    return challenge;
  }

  /**
   * For a failure inside a challenge's transaction that isn't one of ours (e.g. it lost a race and
   * ran out of serialization retries): if the challenge has meanwhile been consumed or exhausted,
   * that is the answer (`AUTH_MFA_CHALLENGE_INVALID`); otherwise the original error stands.
   */
  async rethrowUnlessGone(token: string, purpose: AdminMfaChallengePurpose, err: unknown): Promise<never> {
    await this.resolve(token, purpose);
    throw err;
  }

  /** Counts a failed code, audits it without the code, and throws `AUTH_MFA_CODE_INVALID`. */
  async rejectCode(
    challenge: AdminMfaChallengeRecord,
    user: User,
    step: 'ENROLL' | 'VERIFY' | 'RECOVERY',
    reason: string,
    context: ChallengeRequestContext,
  ): Promise<never> {
    await this.repository.registerFailedAttempt(challenge.id, new Date(), MFA_CHALLENGE_MAX_ATTEMPTS);
    await this.audit.record({
      actorUserId: challenge.userId,
      action: 'identity.mfa.challenge_failed',
      resourceType: 'user',
      resourceId: challenge.userId,
      context: { step, reason },
      ip: context.ip ?? null,
    });
    await this.loginHistory.record({
      userId: challenge.userId,
      identifier: identifierOf(user),
      deviceId: null,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      outcome: LoginOutcome.FAILED,
      failureReason: `MFA_${step}_${reason}`,
    });
    throw IdentityErrors.mfaCodeInvalid();
  }

  /** Issues the MFA-verified session that ends a successful second factor. */
  async issueVerifiedSession(
    user: User,
    deviceInfo: DeviceInfo,
    context: ChallengeRequestContext,
  ): Promise<IssuedSession> {
    user.assertCanAuthenticate();
    const session = await this.sessionIssuer.issue({
      user,
      deviceInfo,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      mfaVerifiedAt: new Date(),
    });
    await this.loginHistory.record({
      userId: user.id,
      identifier: identifierOf(user),
      deviceId: null,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      outcome: LoginOutcome.SUCCESS,
    });
    return session;
  }
}

function identifierOf(user: User): string {
  return user.email ?? user.phone ?? user.id;
}
