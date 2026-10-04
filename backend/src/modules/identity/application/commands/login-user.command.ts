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
import { HASHER, IHasher } from '../ports/hasher.port';
import { AuthSessionIssuerService, IssuedSession } from '../services/auth-session-issuer.service';

export interface LoginUserInput {
  identifier: string;
  password: string;
  deviceInfo: DeviceInfo;
  ip?: string | null;
  userAgent?: string | null;
}

export type LoginUserOutput = IssuedSession;

/**
 * Password login use case (module-01 §3.3 F-LOG-01, §11.2, §13.2). MFA/step-up gating
 * (F-LOG-05) is out of scope for this slice — every account authenticates directly once ACTIVE.
 */
@Injectable()
export class LoginUserCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(HASHER) private readonly hasher: IHasher,
    @Inject(LOGIN_HISTORY_REPOSITORY) private readonly loginHistory: ILoginHistoryRepository,
    private readonly sessionIssuer: AuthSessionIssuerService,
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
