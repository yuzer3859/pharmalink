import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { accountSuspendedEvent } from '../../domain/events';
import {
  IRefreshTokenRepository,
  ISessionRepository,
  REFRESH_TOKEN_REPOSITORY,
  SESSION_REPOSITORY,
} from '../../domain/repositories/auth.repositories';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { PermissionChangeService } from '../services/permission-change.service';

export interface SuspendUserInput {
  targetUserId: string;
  reason: string;
  /** null when the platform itself suspends (e.g. the licence-expiry job, BRULE-08). */
  actorUserId: string | null;
  ip?: string | null;
}

/**
 * POST /admin/users/{id}/suspend (module-01 §11.7, permission `user:suspend:any`). Suspension
 * must take effect immediately, so it cuts every active credential: sessions and refresh tokens
 * are revoked, and the permVersion bump makes JwtAuthGuard reject already-issued access tokens.
 */
@Injectable()
export class SuspendUserCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: ISessionRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: IRefreshTokenRepository,
    private readonly permissionChange: PermissionChangeService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: SuspendUserInput): Promise<void> {
    if (input.actorUserId !== null && input.targetUserId === input.actorUserId) {
      throw ApiException.businessRule('You cannot suspend your own account.');
    }

    const user = await this.users.findById(input.targetUserId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }

    user.suspend();
    // Persist the status before propagating: propagate() increments permVersion in the database,
    // and saving afterwards would write back this aggregate's now-stale in-memory version.
    await this.users.save(user);

    await this.refreshTokens.revokeAllForUser(user.id);
    await this.sessions.revokeAllForUser(user.id);
    await this.permissionChange.propagate([user.id]);

    await this.outbox.write(
      accountSuspendedEvent({
        userId: user.id,
        actorUserId: input.actorUserId ?? 'SYSTEM',
        reason: input.reason,
      }),
    );

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'identity.account.suspended',
      resourceType: 'user',
      resourceId: user.id,
      context: { reason: input.reason },
      ip: input.ip ?? null,
    });
  }
}
