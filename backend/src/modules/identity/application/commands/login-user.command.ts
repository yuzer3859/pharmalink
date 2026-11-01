import { Inject, Injectable } from '@nestjs/common';
import { LoginOutcome } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import {
  DeviceInfo,
  ILoginHistoryRepository,
  LOGIN_HISTORY_REPOSITORY,
} from '../../domain/repositories/auth.repositories';
import { normalizeIdentifier } from '../../domain/value-objects/identifier';
import { AdminMfaAuditor } from '../services/admin-mfa-auditor.service';
import { ADMIN_MFA_REPOSITORY, IAdminMfaRepository } from '../../domain/repositories/admin-mfa.repository';
import { HASHER, IHasher } from '../ports/hasher.port';
import { AdminMfaChallengeService, MfaChallengeView } from '../services/admin-mfa-challenge.service';
import { AdminMfaPolicy } from '../services/admin-mfa-policy.service';
import { AuthSessionIssuerService, IssuedSession } from '../services/auth-session-issuer.service';

export interface LoginUserInput {
  identifier: string;
  password: string;
  deviceInfo: DeviceInfo;
  ip?: string | null;
  userAgent?: string | null;
}

/** A session, or (platform administrators) an MFA challenge and no session. */
export type LoginUserOutput = IssuedSession | MfaChallengeView;

/**
 * Password login use case (module-01 §3.3 F-LOG-01, F-LOG-05, §11.2, §13.2).
 *
 * Platform administrators (Work 66) never get a session from the password alone. They get a
 * five-minute challenge instead: `TOTP` when an authenticator is enrolled, `ENROLLMENT` when not.
 * The decision comes from stored roles, never from anything the client sends. Everyone else signs
 * in as before.
 */
@Injectable()
export class LoginUserCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(HASHER) private readonly hasher: IHasher,
    @Inject(LOGIN_HISTORY_REPOSITORY) private readonly loginHistory: ILoginHistoryRepository,
    private readonly sessionIssuer: AuthSessionIssuerService,
    private readonly mfaPolicy: AdminMfaPolicy,
    private readonly mfaChallenges: AdminMfaChallengeService,
    @Inject(ADMIN_MFA_REPOSITORY) private readonly mfa: IAdminMfaRepository,
    private readonly audit: AdminMfaAuditor,
  ) {}

  async execute(input: LoginUserInput): Promise<LoginUserOutput> {
    // Identifiers are stored canonically (E.164 phone / lowercased email), so a user typing
    // "0911234567" or "User@Example.com" must be normalized before lookup or login always fails.
    const identifier = normalizeIdentifier(input.identifier);
    if (!identifier) {
      await this.recordFailure(input, 'IDENTIFIER_MALFORMED');
      throw IdentityErrors.invalidCredentials();
    }

    const user = await this.users.findByIdentifier(identifier.value);

    if (!user || !user.passwordHash) {
      await this.recordFailure(input, 'IDENTIFIER_OR_PASSWORD', null, identifier.value);
      throw IdentityErrors.invalidCredentials();
    }

    const passwordMatches = await this.hasher.verify(input.password, user.passwordHash);
    if (!passwordMatches) {
      await this.recordFailure(input, 'IDENTIFIER_OR_PASSWORD', user.id, identifier.value);
      throw IdentityErrors.invalidCredentials();
    }

    try {
      user.assertCanAuthenticate();
    } catch (err) {
      await this.recordFailure(input, 'ACCOUNT_STATUS', user.id, identifier.value);
      throw err;
    }

    if (await this.mfaPolicy.requiresMfa(user.id)) {
      const enrolled = (await this.mfa.findCredential(user.id)) !== null;
      const challenge = await this.mfaChallenges.issue(user.id, enrolled ? 'VERIFY' : 'ENROLL');
      await this.loginHistory.record({
        userId: user.id,
        identifier: identifier.value,
        deviceId: null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        outcome: LoginOutcome.MFA_REQUIRED,
        failureReason: enrolled ? null : 'MFA_NOT_ENROLLED',
      });
      await this.audit.record({
        actorUserId: user.id,
        action: 'identity.mfa.challenge_issued',
        resourceType: 'user',
        resourceId: user.id,
        context: { purpose: enrolled ? 'VERIFY' : 'ENROLL' },
        ip: input.ip ?? null,
      });
      return challenge;
    }

    const tokens = await this.sessionIssuer.issue({
      user,
      deviceInfo: input.deviceInfo,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });

    await this.loginHistory.record({
      userId: user.id,
      identifier: identifier.value,
      deviceId: null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      outcome: LoginOutcome.SUCCESS,
    });

    return tokens;
  }

  private async recordFailure(
    input: LoginUserInput,
    reason: string,
    userId: string | null = null,
    /** Canonical identifier when it could be parsed; the raw attempt otherwise. */
    identifier: string = input.identifier,
  ): Promise<void> {
    await this.loginHistory.record({
      userId,
      identifier,
      deviceId: null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      outcome: LoginOutcome.FAILED,
      failureReason: reason,
    });
  }
}
