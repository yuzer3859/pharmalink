import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { AccountStatus, PrimaryRole } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import {
  IOrganizationRepository,
  ORGANIZATION_REPOSITORY,
  OrganizationRecord,
} from '../../domain/repositories/organization.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { PermissionChangeService } from '../services/permission-change.service';

import { normalizeLegalName } from './apply-pharmacy-organization.command';

/** Work 160: the organisation types a healthcare facility is, and the administrator role it gets. */
export const FACILITY_ORGANIZATION_TYPES = ['HOSPITAL', 'CLINIC', 'LAB'] as const;
export type FacilityOrganizationType = (typeof FACILITY_ORGANIZATION_TYPES)[number];

export function facilityAdminRole(type: FacilityOrganizationType): 'HOSPITAL_ADMIN' | 'DIAGNOSTIC_CENTER_ADMIN' {
  return type === 'LAB' ? 'DIAGNOSTIC_CENTER_ADMIN' : 'HOSPITAL_ADMIN';
}

export interface ApplyFacilityOrganizationInput {
  /** The facility's administrator-to-be (an administrator acts on their behalf, Work 160). */
  actorUserId: string;
  type: FacilityOrganizationType;
  legalName: string;
  idempotencyKey: string;
  ip?: string | null;
}

export interface FacilityOrganizationApplicationView {
  organizationId: string;
  type: string;
  name: string;
  status: string;
  membership: { roleKey: string; organizationId: string };
  createdAt: Date;
}

/**
 * Work 160: a hospital, clinic or lab organisation applied for by its administrator-to-be, the
 * same way a pharmacy owner applies (Work 65): an active, e-mail-verified customer account gets a
 * `PENDING_APPROVAL` organisation of that type with no licence data, and the org-scoped
 * administrator role (`HOSPITAL_ADMIN` for hospitals and clinics, `DIAGNOSTIC_CENTER_ADMIN` for
 * labs and diagnostic centres), in one Serializable transaction, audited; then the permission
 * change is propagated. The facility licence (`FACILITY_LICENSE`) is decided separately.
 *
 * Retries: the same `(owner, idempotencyKey)` with the same name and type returns the existing
 * application; anything else is `IDEMPOTENCY_CONFLICT`.
 */
@Injectable()
export class ApplyFacilityOrganizationCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: IOrganizationRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ApplyFacilityOrganizationInput): Promise<FacilityOrganizationApplicationView> {
    if (!(FACILITY_ORGANIZATION_TYPES as readonly string[]).includes(input.type)) {
      throw IdentityErrors.validation('The facility type must be HOSPITAL, CLINIC or LAB.', { field: 'type' });
    }
    const roleKey = facilityAdminRole(input.type);
    const user = await this.users.findById(input.actorUserId);
    if (!user || user.status !== AccountStatus.ACTIVE) {
      throw IdentityErrors.pharmacyApplicationNotEligible('ACCOUNT_NOT_ACTIVE');
    }
    if (!user.emailVerifiedAt) {
      throw IdentityErrors.pharmacyApplicationNotEligible('EMAIL_NOT_VERIFIED');
    }
    if (user.primaryRole !== PrimaryRole.CUSTOMER) {
      throw IdentityErrors.pharmacyApplicationNotEligible('NOT_A_CUSTOMER');
    }

    const name = normalizeLegalName(input.legalName);
    const previous = await this.organizations.findByOwnerAndApplicationKey(user.id, input.idempotencyKey);
    if (previous) return this.replay(previous, name, input.type);

    let created: OrganizationRecord;
    try {
      created = await this.uow.run(
        async (tx) => {
          const role = await this.organizations.findRoleByKey(roleKey, tx);
          if (!role || role.scope !== 'ORG') {
            throw IdentityErrors.roleCatalogMissing(roleKey);
          }
          const org = await this.organizations.createPendingPharmacy(
            { ownerUserId: user.id, name, applicationKey: input.idempotencyKey, type: input.type },
            tx,
          );
          const { assignmentId } = await this.organizations.addMembership(
            { userId: user.id, roleId: role.id, organizationId: org.id, assignedBy: user.id },
            tx,
          );
          await this.audit.record(
            {
              actorUserId: user.id,
              action: 'identity.organization.facility_application_created',
              resourceType: 'organization',
              resourceId: org.id,
              context: { type: org.type, status: org.status },
              ip: input.ip ?? null,
            },
            tx,
          );
          await this.audit.record(
            {
              actorUserId: user.id,
              action: 'rbac.user_role.assigned',
              resourceType: 'user',
              resourceId: user.id,
              context: { roleKey, organizationId: org.id, assignmentId, via: 'facility_application' },
              ip: input.ip ?? null,
            },
            tx,
          );
          return org;
        },
        { isolation: 'serializable' },
      );
    } catch (err) {
      if (err instanceof ApiException) throw err;
      // A concurrent request with the same key committed first (unique violation): answer as a retry.
      const winner = await this.organizations.findByOwnerAndApplicationKey(user.id, input.idempotencyKey);
      if (winner) return this.replay(winner, name, input.type);
      throw err;
    }

    await this.permissionChange.propagate([user.id]);
    return toView(created, roleKey);
  }

  private replay(existing: OrganizationRecord, name: string, type: FacilityOrganizationType): FacilityOrganizationApplicationView {
    if (existing.type !== type || existing.name !== name) {
      throw IdentityErrors.applicationKeyConflict();
    }
    return toView(existing, facilityAdminRole(type));
  }
}

function toView(org: OrganizationRecord, roleKey: string): FacilityOrganizationApplicationView {
  return {
    organizationId: org.id,
    type: org.type,
    name: org.name,
    status: org.status,
    membership: { roleKey, organizationId: org.id },
    createdAt: org.createdAt,
  };
}
