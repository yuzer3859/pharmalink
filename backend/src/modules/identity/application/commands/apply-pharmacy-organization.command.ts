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

const OWNER_ROLE = 'PHARMACY_OWNER';

export interface ApplyPharmacyOrganizationInput {
  /** From the access token (`@CurrentUser()`), never from the request body. */
  actorUserId: string;
  legalName: string;
  idempotencyKey: string;
  ip?: string | null;
}

export interface PharmacyOrganizationApplicationView {
  organizationId: string;
  type: string;
  name: string;
  status: string;
  membership: { roleKey: typeof OWNER_ROLE; organizationId: string };
  createdAt: Date;
}

/** Trims and collapses internal whitespace, so "Abebe  Pharmacy " and "Abebe Pharmacy" are one name. */
export function normalizeLegalName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * `POST /organizations/pharmacy` (Work 65): an active, e-mail-verified customer applies to own a
 * pharmacy organisation.
 *
 * Creates, in one Serializable transaction, an Identity-owned `Organization` that is always
 * `PHARMACY` and `PENDING_APPROVAL` with no licence data, the caller's org-scoped `PHARMACY_OWNER`
 * membership (the primary role stays CUSTOMER), and the audit entries. Then it propagates the
 * permission change: the caller's current access token is rejected (`TOKEN_EXPIRED`) and a refresh
 * yields one carrying the owner's org permissions, including `pharmacy:register`.
 *
 * An application is not an approval. Licence review, organisation approval and pharmacy activation
 * remain separate, explicitly authorized steps. E-mail verification is not Fayda verification and
 * nothing here touches `faydaVerifiedAt`.
 *
 * Retries: `(ownerUserId, idempotencyKey)` is unique in the database. The same key with the same
 * name returns the existing application; with a different name it is `IDEMPOTENCY_CONFLICT`.
 */
@Injectable()
export class ApplyPharmacyOrganizationCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: IOrganizationRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ApplyPharmacyOrganizationInput): Promise<PharmacyOrganizationApplicationView> {
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
    if (previous) return this.replay(previous, name);

    let created: OrganizationRecord;
    try {
      created = await this.uow.run(
        async (tx) => {
          const role = await this.organizations.findRoleByKey(OWNER_ROLE, tx);
          if (!role || role.scope !== 'ORG') {
            throw IdentityErrors.roleCatalogMissing(OWNER_ROLE);
          }
          const org = await this.organizations.createPendingPharmacy(
            { ownerUserId: user.id, name, applicationKey: input.idempotencyKey },
            tx,
          );
          const { assignmentId } = await this.organizations.addMembership(
            { userId: user.id, roleId: role.id, organizationId: org.id, assignedBy: user.id },
            tx,
          );
          await this.audit.record(
            {
              actorUserId: user.id,
              action: 'identity.organization.pharmacy_application_created',
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
              context: { roleKey: OWNER_ROLE, organizationId: org.id, assignmentId, via: 'pharmacy_application' },
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
      if (winner) return this.replay(winner, name);
      throw err;
    }

    await this.permissionChange.propagate([user.id]);
    return toView(created);
  }

  private replay(existing: OrganizationRecord, name: string): PharmacyOrganizationApplicationView {
    if (existing.type !== 'PHARMACY' || existing.name !== name) {
      throw IdentityErrors.applicationKeyConflict();
    }
    return toView(existing);
  }
}

function toView(org: OrganizationRecord): PharmacyOrganizationApplicationView {
  return {
    organizationId: org.id,
    type: org.type,
    name: org.name,
    status: org.status,
    membership: { roleKey: OWNER_ROLE, organizationId: org.id },
    createdAt: org.createdAt,
  };
}
