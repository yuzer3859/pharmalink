import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { IdentityErrors } from '../../domain/errors';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { HASHER, IHasher } from '../ports/hasher.port';
import { PermissionChangeService } from '../services/permission-change.service';
import { LogoutAllCommand } from './logout.command';

/**
 * Retention grace period before an erasure request becomes eligible for purge. Gives the user a
 * window to reverse an accidental or coerced request, and covers regulated retention obligations
 * that outlive the request itself.
 */
export const DELETION_GRACE_DAYS = 30;

export interface RequestAccountDeletionInput {
  userId: string;
  /** Step-up proof — see DeactivateAccountCommand. */
  password: string;
  reason?: string | null;
  ip?: string | null;
}

export interface RequestAccountDeletionOutput {
  requestedAt: Date;
  /** When the scheduled purge may erase the record. */
  purgeEligibleAt: Date;
}

/**
 * POST /users/me/delete-request (NFR-PRIV-04, module-01 §11.5). Records the request and disables
 * the account; the erasure itself is performed later by the retention purge (§4, §16), which is
 * not part of this module. Deliberately does not set `deletedAt` — that flag means "erased", and
 * setting it here would misreport an account that still holds all of its data.
 */
@Injectable()
export class RequestAccountDeletionCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(HASHER) private readonly hasher: IHasher,
    private readonly logoutAll: LogoutAllCommand,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RequestAccountDeletionInput): Promise<RequestAccountDeletionOutput> {
    const user = await this.users.findById(input.userId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }
    if (!user.passwordHash || !(await this.hasher.verify(input.password, user.passwordHash))) {
      throw IdentityErrors.invalidCredentials();
    }

    user.requestDeletion();
    await this.users.save(user);

    await this.logoutAll.execute(user.id, 'DELETION_REQUESTED');
    await this.permissionChange.propagate([user.id]);

    const requestedAt = user.deletionRequestedAt as Date;
    const purgeEligibleAt = new Date(
      requestedAt.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.audit.record({
      actorUserId: user.id,
      action: 'privacy.data_deletion_requested',
      resourceType: 'user',
      resourceId: user.id,
      context: {
        reason: input.reason ?? null,
        requestedAt: requestedAt.toISOString(),
        purgeEligibleAt: purgeEligibleAt.toISOString(),
      },
      ip: input.ip ?? null,
    });

    return { requestedAt, purgeEligibleAt };
  }
}
