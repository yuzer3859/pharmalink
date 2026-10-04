import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { IdentityErrors } from '../../domain/errors';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { HASHER, IHasher } from '../ports/hasher.port';
import { PermissionChangeService } from '../services/permission-change.service';
import { LogoutAllCommand } from './logout.command';

export interface DeactivateAccountInput {
  userId: string;
  /**
   * Step-up proof. §11.5 mandates step-up for this action; until MFA/STEP_UP OTP ships, re-entering
   * the current password is the available second factor and is enforced here, not optional.
   */
  password: string;
  ip?: string | null;
}

export interface DeactivateAccountOutput {
  status: string;
}

/** POST /users/me/deactivate (module-01 §3.7 FR-AC-12, §11.5). */
@Injectable()
export class DeactivateAccountCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(HASHER) private readonly hasher: IHasher,
    private readonly logoutAll: LogoutAllCommand,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: DeactivateAccountInput): Promise<DeactivateAccountOutput> {
    const user = await this.users.findById(input.userId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }
    if (!user.passwordHash || !(await this.hasher.verify(input.password, user.passwordHash))) {
      throw IdentityErrors.invalidCredentials();
    }

    user.deactivate();
    await this.users.save(user);

    await this.logoutAll.execute(user.id, 'ACCOUNT_DEACTIVATED');
    await this.permissionChange.propagate([user.id]);

    await this.audit.record({
      actorUserId: user.id,
      action: 'identity.account.deactivated',
      resourceType: 'user',
      resourceId: user.id,
      ip: input.ip ?? null,
    });

    return { status: user.status };
  }
}
