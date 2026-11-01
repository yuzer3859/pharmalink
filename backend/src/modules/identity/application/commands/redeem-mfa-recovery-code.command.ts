import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { IdentityErrors } from '../../domain/errors';
import { hashRecoveryCode, normalizeRecoveryCode } from '../../domain/mfa/recovery-codes';
import { ADMIN_MFA_REPOSITORY, IAdminMfaRepository } from '../../domain/repositories/admin-mfa.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import {
  AdminMfaChallengeService,
  ChallengeRequestContext,
  MFA_CHALLENGE_MAX_ATTEMPTS,
  MfaChallengeView,
} from '../services/admin-mfa-challenge.service';

export interface RedeemMfaRecoveryCodeInput extends ChallengeRequestContext {
  challengeToken: string;
  recoveryCode: string;
}

/**
 * Lost-authenticator recovery (Work 66). After the password factor, an unused recovery code is
 * consumed atomically together with the TOTP challenge, and the result is **not** a session: it is
 * a new ENROLL challenge that replaces the authenticator. A session is issued only after a code from
 * the new authenticator confirms it (`ConfirmMfaEnrollmentCommand`), which also issues a fresh set of
 * recovery codes. A recovery code is therefore never an MFA bypass on its own.
 */
@Injectable()
export class RedeemMfaRecoveryCodeCommand {
  constructor(
    @Inject(ADMIN_MFA_REPOSITORY) private readonly repository: IAdminMfaRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly challenges: AdminMfaChallengeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RedeemMfaRecoveryCodeInput): Promise<MfaChallengeView> {
    const challenge = await this.challenges.resolve(input.challengeToken, 'VERIFY');
    const user = await this.users.findById(challenge.userId);
    if (!user || !(await this.repository.findCredential(user.id))) {
      throw IdentityErrors.mfaChallengeInvalid();
    }
    user.assertCanAuthenticate();

    const normalized = normalizeRecoveryCode(input.recoveryCode);
    if (normalized === null) {
      return this.challenges.rejectCode(challenge, user, 'RECOVERY', 'CODE_MISMATCH', input);
    }
    const codeHash = hashRecoveryCode(normalized);

    const result = await this.uow.run(
      async (tx) => {
        const now = new Date();
        if (!(await this.repository.consumeChallenge(challenge.id, now, MFA_CHALLENGE_MAX_ATTEMPTS, tx))) {
          return { kind: 'CHALLENGE_GONE' as const };
        }
        if (!(await this.repository.consumeRecoveryCode(user.id, codeHash, now, tx))) {
          throw new RecoveryCodeRejected();
        }
        const enrollment = await this.challenges.issue(user.id, 'ENROLL', { replacesCredential: true, tx });
        await this.audit.record(
          {
            actorUserId: user.id,
            action: 'identity.mfa.recovery_code_used',
            resourceType: 'user',
            resourceId: user.id,
            context: { next: 'AUTHENTICATOR_REPLACEMENT' },
            ip: input.ip ?? null,
          },
          tx,
        );
        return { kind: 'OK' as const, enrollment };
      },
      { isolation: 'serializable' },
    ).catch((err: unknown) => {
      if (err instanceof RecoveryCodeRejected) return { kind: 'CODE_REJECTED' as const };
      return this.challenges.rethrowUnlessGone(input.challengeToken, 'VERIFY', err);
    });

    if (result.kind === 'CHALLENGE_GONE') {
      throw IdentityErrors.mfaChallengeInvalid();
    }
    if (result.kind === 'CODE_REJECTED') {
      return this.challenges.rejectCode(challenge, user, 'RECOVERY', 'CODE_MISMATCH', input);
    }
    return result.enrollment;
  }
}

class RecoveryCodeRejected extends Error {}
