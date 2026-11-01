export const ORGANIZATION_REPOSITORY = Symbol('ORGANIZATION_REPOSITORY');

export interface OrganizationRecord {
  id: string;
  type: string;
  name: string;
  status: string;
  ownerUserId: string;
  applicationKey: string | null;
  createdAt: Date;
}

export interface RoleRecord {
  id: string;
  key: string;
  scope: string;
}

/**
 * Identity-owned persistence for organisations and their org-scoped memberships (Work 65,
 * module-01 §5). Module 04 reads organisations through its `IIdentityPort`; it never writes here.
 */
export interface IOrganizationRepository {
  findByOwnerAndApplicationKey(ownerUserId: string, applicationKey: string, tx?: unknown): Promise<OrganizationRecord | null>;
  findRoleByKey(roleKey: string, tx?: unknown): Promise<RoleRecord | null>;
  /** Always `type = PHARMACY`, `status = PENDING_APPROVAL`, no licence fields. */
  createPendingPharmacy(
    input: { ownerUserId: string; name: string; applicationKey: string },
    tx: unknown,
  ): Promise<OrganizationRecord>;
  /** Creates one org-scoped `user_roles` row. */
  addMembership(
    input: { userId: string; roleId: string; organizationId: string; assignedBy: string },
    tx: unknown,
  ): Promise<{ assignmentId: string }>;
}
