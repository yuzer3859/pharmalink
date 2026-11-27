import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { AccountStatus, PrimaryRole } from '../../domain/enums';
import { IRbacRepository, RBAC_REPOSITORY } from '../../domain/repositories/rbac.repository';
import { IRoleAssignmentRepository, ROLE_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/role-assignment.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { PermissionChangeService } from '../services/permission-change.service';

/**
 * Work 166: a platform administrator makes an existing account a doctor — the doctor twin of
 * Work 156's `MakeDriverCommand`. The person signs up in the PharmaLink app first. Only a customer
 * account can become one, never an administrator or anyone holding an organisation role (a
 * pharmacy's or a facility's), nor anyone holding another role such as DRIVER. Their primary role becomes DOCTOR and they gain the DOCTOR role;
 * the change takes effect on their next request. Audited as `identity.user.made_doctor`. Already
 * a doctor: nothing changes.
 */
@Injectable()
export class MakeDoctorCommand {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository,
    @Inject(ROLE_ASSIGNMENT_REPOSITORY) private readonly roleAssignments: IRoleAssignmentRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: { userId: string; actorUserId: string; ip?: string | null }): Promise<{ changed: boolean }> {
    const user = await this.users.findById(input.userId);
    if (!user) throw ApiException.notFound('User not found');
    if (user.primaryRole === PrimaryRole.DOCTOR) return { changed: false };
    if (user.status !== AccountStatus.ACTIVE) {
      throw ApiException.businessRule('Only an active account can become a doctor.', { reason: 'ACCOUNT_NOT_ACTIVE' });
    }
    if (user.primaryRole !== PrimaryRole.CUSTOMER) {
      throw ApiException.businessRule('Only a customer account can become a doctor.', { reason: 'NOT_A_CUSTOMER' });
    }
    const assignments = await this.rbac.listAssignmentsForUser(user.id);
    if (assignments.some((a) => a.organizationId)) {
      throw ApiException.businessRule('This account works for a pharmacy or facility, so it cannot also be a doctor.', { reason: 'HAS_ORGANIZATION_ROLE' });
    }
    // A driver, or anyone holding a platform role, is not a doctor too.
    if (assignments.some((a) => a.roleKey !== 'CUSTOMER')) {
      throw ApiException.businessRule('This account already has another role, so it cannot also be a doctor.', { reason: 'HAS_OTHER_ROLE' });
    }

    await this.uow.run(async (tx) => {
      user.becomeDoctor();
      await this.users.save(user, tx);
      await this.roleAssignments.assignByRoleKey(user.id, 'DOCTOR', null, tx);
    });
    await this.permissionChange.propagate([user.id]);
    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'identity.user.made_doctor',
      resourceType: 'user',
      resourceId: user.id,
      context: { previousPrimaryRole: PrimaryRole.CUSTOMER },
      ip: input.ip ?? null,
    });
    return { changed: true };
  }
}
