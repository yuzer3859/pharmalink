export const ORGANIZATION_REPOSITORY = Symbol('ORGANIZATION_REPOSITORY');

export interface OrganizationRecord {
  id: string;
  type: string;
  name: string;
  status: string;
  ownerUserId: string;
  applicationKey: string | null;
  licenseNumber: string | null;
  licenseExpiresAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
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
  /** Includes soft-deleted organisations; callers check `deletedAt`. */
  findById(id: string, tx?: unknown): Promise<OrganizationRecord | null>;
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
  /**
   * Pharmacy licence approval (Work 67): sets the approved licence number and expiry and makes
   * the organisation ACTIVE, from any status. Conditional on the row still being an undeleted
   * PHARMACY owned by `ownerUserId`; returns false (and changes nothing) otherwise.
   */
  recordApprovedLicense(
    input: { organizationId: string; ownerUserId: string; licenseNumber: string; licenseExpiresAt: Date },
    tx: unknown,
  ): Promise<boolean>;
  /**
   * An initial application was rejected: PENDING_APPROVAL → REJECTED. Any other status is left
   * alone (a renewal's rejection never touches a current licence). Returns whether it changed.
   */
  rejectPendingApplication(organizationId: string, tx: unknown): Promise<boolean>;
  /**
   * The organisation's current licence expired: ACTIVE → SUSPENDED, only while the stored licence
   * number and expiry are still the expired licence's, and that expiry is `<= now`. A renewal
   * approved in the meantime changed them, so the suspension does not apply. Returns whether it
   * changed.
   */
  suspendForExpiredLicense(
    input: { organizationId: string; licenseNumber: string | null; licenseExpiresAt: Date; now: Date },
    tx: unknown,
  ): Promise<boolean>;
}
