import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { IdentityErrors } from '../../domain/errors';
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from '../../domain/mfa/recovery-codes';
import { matchTotp } from '../../domain/mfa/totp';
import { ADMIN_MFA_REPOSITORY, IAdminMfaRepository } from '../../domain/repositories/admin-mfa.repository';
import { IMfaSecretCipher, MFA_SECRET_CIPHER } from '../ports/mfa-secret-cipher.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { AdminMfaAuditor } from '../services/admin-mfa-auditor.service';

export interface RotateMfaRecoveryCodesInput {
  /** From the access token, never the body. */
  userId: string;
  code: string;
  ip?: string | null;
}

/**
 * Replaces an administrator's recovery codes (Work 66). Requires a current authenticator code,
 * held to the same replay rule as sign-in (the step must be newer than any accepted before), even
 * though the caller already has an MFA-verified session: whoever holds a stolen access token must
 * not be able to mint recovery codes.
 */
@Injectable()
export class RotateMfaRecoveryCodesCommand {
  constructor(
    @Inject(ADMIN_MFA_REPOSITORY) private readonly repository: IAdminMfaRepository,
    @Inject(MFA_SECRET_CIPHER) private readonly cipher: IMfaSecretCipher,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly auditor: AdminMfaAuditor,
  ) {}

  async execute(input: RotateMfaRecoveryCodesInput): Promise<{ recoveryCodes: string[] }> {
    const credential = await this.repository.findCredential(input.userId);
    if (!credential) {
      throw IdentityErrors.mfaCodeInvalid();
    }
    const secret = this.cipher.decrypt(credential.encryptedSecret, input.userId);
    const step = matchTotp(secret, input.code, Date.now());
    if (step === null || (credential.lastUsedStep !== null && step <= credential.lastUsedStep)) {
      await this.recordFailure(input, step === null ? 'CODE_MISMATCH' : 'CODE_REPLAYED');
      throw IdentityErrors.mfaCodeInvalid();
    }

    const recoveryCodes = generateRecoveryCodes();
    const codeHashes = recoveryCodes.map((code) => hashRecoveryCode(normalizeRecoveryCode(code)!));
    const rotated = await this.uow.run(
      async (tx) => {
        if (!(await this.repository.advanceTimeStep(input.userId, step, tx))) {
          return false;
        }
        await this.repository.replaceRecoveryCodes(input.userId, codeHashes, tx);
        await this.audit.record(
          {
            actorUserId: input.userId,
            action: 'identity.mfa.recovery_codes_rotated',
            resourceType: 'user',
            resourceId: input.userId,
            context: { recoveryCodes: codeHashes.length },
            ip: input.ip ?? null,
          },
          tx,
        );
        return true;
      },
      { isolation: 'serializable' },
    );
    if (!rotated) {
      await this.recordFailure(input, 'CODE_REPLAYED');
      throw IdentityErrors.mfaCodeInvalid();
    }
    return { recoveryCodes };
  }

  private async recordFailure(input: RotateMfaRecoveryCodesInput, reason: string): Promise<void> {
    await this.auditor.record({
      actorUserId: input.userId,
      action: 'identity.mfa.challenge_failed',
      resourceType: 'user',
      resourceId: input.userId,
      context: { step: 'ROTATE_RECOVERY_CODES', reason },
      ip: input.ip ?? null,
    });
  }
}
