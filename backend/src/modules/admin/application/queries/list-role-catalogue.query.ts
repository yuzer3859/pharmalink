import { Inject, Injectable } from '@nestjs/common';
import {
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
  RoleCatalogueView,
} from '../../../identity/application/ports/inbound/identity-admin.port';

/**
 * `GET /admin/roles` (module-16 §9.2, F-AD-07) — the roles an administrator may assign.
 *
 * Read-only, and exactly Module 01's catalogue: the same rows its own `GET /admin/rbac/roles`
 * returns, including each role's permission keys, which Module 01 already exposes to the same
 * permission. Nothing here creates, edits or deletes a role — the catalogue is seeded from
 * `rbac-catalog.ts` and its permission sets are changed only through Module 01's
 * `POST /admin/rbac/roles/:id/permissions`.
 */
@Injectable()
export class ListRoleCatalogueQuery {
  constructor(@Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort) {}

  execute(): Promise<RoleCatalogueView[]> {
    return this.identity.listRoles();
  }
}
