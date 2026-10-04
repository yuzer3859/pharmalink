import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import {
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
  UserDetailView,
} from '../../../identity/application/ports/inbound/identity-admin.port';

/**
 * `GET /admin/users/:id` (module-16 §9.2) — one account as Module 01 describes it.
 *
 * The shape is Module 01's `UserDetailView`, unchanged: contact details, role, status,
 * verification timestamps, and the role assignments that are the account's organization
 * association. Nothing that authenticates the account is in it, and nothing here reaches past
 * Module 01 for a profile, an organization record or a verification document — none of those
 * have a read contract for admin use, and this work invents none.
 */
@Injectable()
export class GetUserQuery {
  constructor(@Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort) {}

  async execute(userId: string): Promise<UserDetailView> {
    const user = await this.identity.getUser(userId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }
    return user;
  }
}
