import { Inject, Injectable } from '@nestjs/common';
import { ADMIN_MFA_REPOSITORY, IAdminMfaRepository } from '../../domain/repositories/admin-mfa.repository';
import { AdminMfaPolicy } from '../services/admin-mfa-policy.service';

export interface MfaStatusView {
  /** The account is a platform administrator, so MFA is mandatory for it. */
  required: boolean;
  enrolled: boolean;
  enabledAt: Date | null;
  recoveryCodesRemaining: number;
}

/** The caller's own administrator MFA status (Work 66). Contains no secret material. */
@Injectable()
export class GetMfaStatusQuery {
  constructor(
    @Inject(ADMIN_MFA_REPOSITORY) private readonly repository: IAdminMfaRepository,
    private readonly policy: AdminMfaPolicy,
  ) {}

  async execute(userId: string): Promise<MfaStatusView> {
    const [required, credential] = await Promise.all([
      this.policy.requiresMfa(userId),
      this.repository.findCredential(userId),
    ]);
    return {
      required,
      enrolled: credential !== null,
      enabledAt: credential?.enabledAt ?? null,
      recoveryCodesRemaining: credential ? await this.repository.countUnusedRecoveryCodes(userId) : 0,
    };
  }
}
