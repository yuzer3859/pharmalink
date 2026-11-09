import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import { IRbacRepository, RBAC_REPOSITORY } from '../../domain/repositories/rbac.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { normalizeIdentifier } from '../../domain/value-objects/identifier';
import { AssignUserRoleCommand } from '../commands/assign-user-role.command';
import { RevokeUserRoleCommand } from '../commands/revoke-user-role.command';

/** The roles a pharmacy can give its staff. The owner role is the organisation's, never handed out. */
export const PHARMACY_STAFF_ROLES = ['PHARMACY_MANAGER', 'PHARMACIST', 'CASHIER', 'INVENTORY_STAFF'] as const;
export type PharmacyStaffRole = (typeof PHARMACY_STAFF_ROLES)[number];

const MANAGE_STAFF = 'staff:manage:org';

export interface PharmacyStaffMember {
  userId: string;
  email: string | null;
  phone: string | null;
  status: string;
  roles: Array<{ roleKey: string; roleName: string; assignedAt: Date }>;
}

export const PHARMACY_STAFF_READ_PORT = Symbol('PHARMACY_STAFF_READ_PORT');

export interface IPharmacyStaffReadPort {
  /** Everyone holding a role at the organisation, with those roles, oldest member first. */
  listMembers(organizationId: string): Promise<PharmacyStaffMember[]>;
}

/**
 * Work 113: a pharmacy's staff (module-04 §9.2), over Module 01's own audited role commands.
 *
 * - The organisation is the one where the caller holds a role granting `staff:manage:org` (the
 *   owner or a manager); a caller who manages none is refused. Nothing in the request names it.
 * - **Adding staff gives an existing PharmaLink account a pharmacy role**, found by e-mail.
 *   module-04's "invite" assumed an invitation e-mail. While Resend's test sender is in use, that
 *   e-mail cannot be delivered, and Module 01 has no invitation flow (decision recorded in
 *   `architecture/phase-1-status.md`). The person signs up first, then the pharmacy adds them.
 * - Only the staff roles can be given or taken. The owner role is never touched, and nobody
 *   changes their own roles, so a manager cannot lock the pharmacy out by accident.
 */
@Injectable()
export class PharmacyStaffService {
  constructor(
    @Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(PHARMACY_STAFF_READ_PORT) private readonly read: IPharmacyStaffReadPort,
    private readonly assign: AssignUserRoleCommand,
    private readonly revoke: RevokeUserRoleCommand,
  ) {}

  async managedOrganization(actorUserId: string): Promise<string> {
    const [assignments, roles] = await Promise.all([this.rbac.listAssignmentsForUser(actorUserId), this.rbac.listRoles()]);
    const managing = new Set(roles.filter((r) => r.permissionKeys.includes(MANAGE_STAFF)).map((r) => r.id));
    const organizationId = assignments.find((a) => a.organizationId && managing.has(a.roleId))?.organizationId;
    if (!organizationId) throw ApiException.forbidden('You do not manage the staff of a pharmacy.');
    return organizationId;
  }

  /**
   * The members, and the staff roles with what each one allows (the RBAC catalogue's own keys), so
   * the portal can show the roles read-only; pharmacy staff cannot read the admin role catalogue.
   */
  async list(actorUserId: string): Promise<{
    organizationId: string;
    items: PharmacyStaffMember[];
    assignableRoles: Array<{ key: string; name: string; description: string | null; permissionKeys: string[] }>;
  }> {
    const organizationId = await this.managedOrganization(actorUserId);
    const [items, roles] = await Promise.all([this.read.listMembers(organizationId), this.rbac.listRoles()]);
    const assignableRoles = PHARMACY_STAFF_ROLES.flatMap((key) => {
      const role = roles.find((r) => r.key === key);
      return role ? [{ key, name: role.name, description: role.description, permissionKeys: [...role.permissionKeys].sort() }] : [];
    });
    return { organizationId, items, assignableRoles };
  }

  async add(input: { actorUserId: string; email: string; roleKey: string; ip?: string | null }) {
    const organizationId = await this.managedOrganization(input.actorUserId);
    if (!(PHARMACY_STAFF_ROLES as readonly string[]).includes(input.roleKey)) {
      throw ApiException.validation('That role cannot be given to pharmacy staff.', { roleKey: input.roleKey, allowed: PHARMACY_STAFF_ROLES });
    }
    const identifier = normalizeIdentifier(input.email);
    if (!identifier || identifier.channel !== 'EMAIL') throw ApiException.validation('Enter the e-mail address of their PharmaLink account.');
    const user = await this.users.findByIdentifier(identifier.value);
    if (!user) {
      throw ApiException.notFound('No PharmaLink account uses that e-mail. Ask them to sign up first, then add them.');
    }
    if (user.id === input.actorUserId) throw ApiException.forbidden('You cannot change your own roles.');
    return this.assign.execute({ targetUserId: user.id, roleKey: input.roleKey, organizationId, actorUserId: input.actorUserId, ip: input.ip ?? null });
  }

  async remove(input: { actorUserId: string; userId: string; roleKey: string; ip?: string | null }): Promise<void> {
    const organizationId = await this.managedOrganization(input.actorUserId);
    if (input.userId === input.actorUserId) throw ApiException.forbidden('You cannot change your own roles.');
    if (!(PHARMACY_STAFF_ROLES as readonly string[]).includes(input.roleKey)) {
      throw ApiException.forbidden('Only pharmacy staff roles can be removed here.');
    }
    const assignment = (await this.rbac.listAssignmentsForUser(input.userId)).find(
      (a) => a.roleKey === input.roleKey && a.organizationId === organizationId,
    );
    if (!assignment) throw ApiException.notFound('That person does not hold that role at your pharmacy.');
    await this.revoke.execute({ targetUserId: input.userId, assignmentId: assignment.id, actorUserId: input.actorUserId, ip: input.ip ?? null });
  }
}
