import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import { IPermissionResolver, PERMISSION_RESOLVER } from '../../../../shared/rbac/rbac.types';
import { IRbacRepository, RBAC_REPOSITORY } from '../../domain/repositories/rbac.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';

export interface CurrentUserRoleView {
  roleKey: string;
  organizationId: string | null;
}

export interface CurrentUserView {
  id: string;
  phone: string | null;
  email: string | null;
  primaryRole: string;
  status: string;
  preferredLanguage: string;
  phoneVerifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  faydaVerified: boolean;
  /** Non-null while a data-deletion request is pending (module-01 §11.5, NFR-PRIV-04). */
  deletionRequestedAt: Date | null;
  /** Effective role assignments, including org-scoped memberships (§11.5). */
  roles: CurrentUserRoleView[];
  /** Flat effective permission set, as the access token carries it. */
  permissions: string[];
}

/** GET /users/me (module-01 §11.5) — current profile plus effective roles/permissions. */
@Injectable()
export class GetCurrentUserQuery {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository,
    @Inject(PERMISSION_RESOLVER) private readonly permissions: IPermissionResolver,
  ) {}

  async execute(userId: string): Promise<CurrentUserView> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }

    const [assignments, permissions] = await Promise.all([
      this.rbac.listAssignmentsForUser(user.id),
      this.permissions.resolvePermissions(user.id),
    ]);

    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      primaryRole: user.primaryRole,
      status: user.status,
      preferredLanguage: user.preferredLanguage,
      phoneVerifiedAt: user.phoneVerifiedAt,
      emailVerifiedAt: user.emailVerifiedAt,
      faydaVerified: user.toProps().faydaVerifiedAt !== null,
      deletionRequestedAt: user.deletionRequestedAt,
      roles: assignments.map((a) => ({ roleKey: a.roleKey, organizationId: a.organizationId })),
      permissions,
    };
  }
}
