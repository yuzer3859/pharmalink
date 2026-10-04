import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { accountReactivatedEvent } from '../../domain/events';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { PermissionChangeService } from '../services/permission-change.service';

export interface ReactivateUserInput {
  targetUserId: string;
  actorUserId: string;
  ip?: string | null;
}

/**
 * POST /admin/users/{id}/reactivate (module-01 §11.7, permission `user:reactivate:any`). The
 * user must sign in again — reactivation restores the account, not the revoked sessions.
 */
@Injectable()
export class ReactivateUserCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    private readonly permissionChange: PermissionChangeService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ReactivateUserInput): Promise<void> {
    const user = await this.users.findById(input.targetUserId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }

    user.reactivate();
    await this.users.save(user);
    await this.permissionChange.propagate([user.id]);

    await this.outbox.write(
      accountReactivatedEvent({ userId: user.id, actorUserId: input.actorUserId }),
    );

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'identity.account.reactivated',
      resourceType: 'user',
      resourceId: user.id,
      ip: input.ip ?? null,
    });
  }
}
