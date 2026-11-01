import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { IdentityErrors } from '../../domain/errors';
import { matchTotp } from '../../domain/mfa/totp';
import { ADMIN_MFA_REPOSITORY, IAdminMfaRepository } from '../../domain/repositories/admin-mfa.repository';
import { DeviceInfo } from '../../domain/repositories/auth.repositories';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { IMfaSecretCipher, MFA_SECRET_CIPHER } from '../ports/mfa-secret-cipher.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import {
  AdminMfaChallengeService,
  ChallengeRequestContext,
  MFA_CHALLENGE_MAX_ATTEMPTS,
} from '../services/admin-mfa-challenge.service';
import { IssuedSession } from '../services/auth-session-issuer.service';

export interface VerifyMfaChallengeInput extends ChallengeRequestContext {
  challengeToken: string;
  code: string;
  deviceInfo: DeviceInfo;
}

/**
 * Completes an administrator's sign-in with an authenticator code (Work 66). The code must match
 * the enrolled secret within ±1 time step, and its step must be newer than any step accepted
 * before. Consuming the challenge and recording the step happen in one transaction of conditional
 * updates, so two concurrent submissions of the same challenge or the same code issue at most one
 * session.
 */
@Injectable()
export class VerifyMfaChallengeCommand {
  constructor(
    @Inject(ADMIN_MFA_REPOSITORY) private readonly repository: IAdminMfaRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(MFA_SECRET_CIPHER) private readonly cipher: IMfaSecretCipher,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly challenges: AdminMfaChallengeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: VerifyMfaChallengeInput): Promise<IssuedSession> {
    const challenge = await this.challenges.resolve(input.challengeToken, 'VERIFY');
    const [user, credential] = await Promise.all([
      this.users.findById(challenge.userId),
      this.repository.findCredential(challenge.userId),
    ]);
    if (!user || !credential) {
      throw IdentityErrors.mfaChallengeInvalid();
    }
    user.assertCanAuthenticate();

    const secret = this.cipher.decrypt(credential.encryptedSecret, user.id);
    const step = matchTotp(secret, input.code, Date.now());
    if (step === null) {
      return this.challenges.rejectCode(challenge, user, 'VERIFY', 'CODE_MISMATCH', input);
    }
    if (credential.lastUsedStep !== null && step <= credential.lastUsedStep) {
      return this.challenges.rejectCode(challenge, user, 'VERIFY', 'CODE_REPLAYED', input);
    }

    const outcome = await this.uow.run(
      async (tx) => {
        const now = new Date();
        if (!(await this.repository.consumeChallenge(challenge.id, now, MFA_CHALLENGE_MAX_ATTEMPTS, tx))) {
          return 'CHALLENGE_GONE' as const;
        }
        if (!(await this.repository.advanceTimeStep(user.id, step, tx))) {
          // Roll back the consumption too: the challenge keeps its remaining attempts.
          throw new StepAlreadyUsed();
        }
        await this.audit.record(
          {
            actorUserId: user.id,
            action: 'identity.mfa.challenge_succeeded',
            resourceType: 'user',
            resourceId: user.id,
            context: { method: 'TOTP' },
            ip: input.ip ?? null,
          },
          tx,
        );
        return 'OK' as const;
      },
      { isolation: 'serializable' },
    ).catch((err: unknown) => {
      if (err instanceof StepAlreadyUsed) return 'STEP_USED' as const;
      return this.challenges.rethrowUnlessGone(input.challengeToken, 'VERIFY', err);
    });

    if (outcome === 'CHALLENGE_GONE') {
      throw IdentityErrors.mfaChallengeInvalid();
    }
    if (outcome === 'STEP_USED') {
      return this.challenges.rejectCode(challenge, user, 'VERIFY', 'CODE_REPLAYED', input);
    }
    return this.challenges.issueVerifiedSession(user, input.deviceInfo, input);
  }
}

class StepAlreadyUsed extends Error {}
