import { Inject, Injectable } from '@nestjs/common';
import { ADMIN_MFA_REPOSITORY, IAdminMfaRepository } from '../../domain/repositories/admin-mfa.repository';
import { IMfaSecretCipher, MFA_SECRET_CIPHER } from '../ports/mfa-secret-cipher.port';

export interface AdminMfaReadiness {
  /** Always true: enforcement has no configuration switch. */
  enforced: boolean;
  /** ADMIN_MFA_ENCRYPTION_KEY is configured and valid. */
  keyConfigured: boolean;
  /** The Work 66 migration has been applied. */
  schemaReady: boolean;
}

/**
 * Mandatory administrator MFA (Work 66): who needs it, and whether this deployment can provide it.
 *
 * There is deliberately no setting that turns enforcement off, in any environment. The privileged
 * check reads stored roles (see `privileged-account.ts`) and throws if it can't, so every caller
 * fails closed.
 */
@Injectable()
export class AdminMfaPolicy {
  constructor(
    @Inject(ADMIN_MFA_REPOSITORY) private readonly repository: IAdminMfaRepository,
    @Inject(MFA_SECRET_CIPHER) private readonly cipher: IMfaSecretCipher,
  ) {}

  isEnforced(): boolean {
    return true;
  }

  requiresMfa(userId: string): Promise<boolean> {
    return this.repository.isPlatformAdministrator(userId);
  }

  async readiness(): Promise<AdminMfaReadiness> {
    return {
      enforced: this.isEnforced(),
      keyConfigured: this.cipher.isConfigured(),
      schemaReady: await this.repository.isSchemaReady().catch(() => false),
    };
  }
}
