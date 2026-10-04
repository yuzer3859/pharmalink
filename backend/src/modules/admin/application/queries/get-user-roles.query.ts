import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import {
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
  UserRoleAssignmentView,
} from '../../../identity/application/ports/inbound/identity-admin.port';

/** `GET /admin/accounts/:id/roles` — the account's role assignments as Module 01 holds them. */
@Injectable()
export class GetUserRolesQuery {
  constructor(@Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort) {}

  async execute(userId: string): Promise<UserRoleAssignmentView[]> {
    const roles = await this.identity.listUserRoles(userId);
    if (roles === null) {
      throw ApiException.notFound('User not found');
    }
    return roles;
  }
}
