import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { IdentityErrors } from '../../domain/errors';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { PasswordPolicy } from '../../domain/value-objects/password-policy';
import { HASHER, IHasher } from '../ports/hasher.port';
import { INotificationPort, NOTIFICATION_PORT } from '../ports/notification.port';
import { PermissionChangeService } from '../services/permission-change.service';
import { LogoutAllCommand } from './logout.command';

export interface ChangePasswordInput {
  userId: string;
  oldPassword: string;
  newPassword: string;
  ip?: string | null;
}

export interface ChangePasswordOutput {
  changed: true;
}

/**
 * POST /auth/password/change (module-01 §11.3). Knowing the current password is required, so a
 * stolen access token alone cannot lock the owner out. Every session is revoked afterwards —
 * including the caller's, who must sign in again; that is the safe default when we cannot tell
 * which session is the legitimate one.
 */
@Injectable()
export class ChangePasswordCommand {
  private readonly passwordPolicy = new PasswordPolicy();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(HASHER) private readonly hasher: IHasher,
    @Inject(NOTIFICATION_PORT) private readonly notifications: INotificationPort,
    private readonly logoutAll: LogoutAllCommand,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ChangePasswordInput): Promise<ChangePasswordOutput> {
    const user = await this.users.findById(input.userId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }
    if (!user.passwordHash) {
      throw IdentityErrors.invalidCredentials();
    }

    const matches = await this.hasher.verify(input.oldPassword, user.passwordHash);
    if (!matches) {
      throw IdentityErrors.invalidCredentials();
    }

    if (input.oldPassword === input.newPassword) {
      throw IdentityErrors.validation('The new password must differ from the current one.', {
        field: 'newPassword',
      });
    }
    this.passwordPolicy.assert(input.newPassword);

    user.changePassword(await this.hasher.hash(input.newPassword));
    await this.users.save(user);

    await this.logoutAll.execute(user.id, 'PASSWORD_CHANGED');
    await this.permissionChange.propagate([user.id]);

    const target = user.phone ?? user.email;
    if (target) {
      await this.notifications.send({
        channel: user.phone ? 'SMS' : 'EMAIL',
        to: target,
        template: 'security-password-changed',
        data: { at: new Date().toISOString() },
      });
    }

    await this.audit.record({
      actorUserId: user.id,
      action: 'identity.password.changed',
      resourceType: 'user',
      resourceId: user.id,
      ip: input.ip ?? null,
    });

    return { changed: true };
  }
}
