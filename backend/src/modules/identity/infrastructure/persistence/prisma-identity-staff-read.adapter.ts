import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IIdentityStaffReadPort,
  STAFF_ROLE_KEYS,
  StaffMemberView,
  StaffRoleKey,
} from '../../application/ports/inbound/identity-staff-read.port';

/** `IIdentityStaffReadPort` over `user_roles` joined to `roles` and `users`. One query. */
@Injectable()
export class PrismaIdentityStaffReadAdapter implements IIdentityStaffReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listStaff(): Promise<StaffMemberView[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { role: { key: { in: [...STAFF_ROLE_KEYS] } } },
      select: {
        userId: true,
        role: { select: { key: true } },
        user: { select: { email: true, phone: true, status: true } },
      },
    });
    const byUser = new Map<string, StaffMemberView>();
    for (const row of rows) {
      const member = byUser.get(row.userId) ?? {
        userId: row.userId,
        email: row.user.email,
        phone: row.user.phone,
        status: row.user.status,
        roles: [],
      };
      const key = row.role.key as StaffRoleKey;
      if (!member.roles.includes(key)) member.roles.push(key);
      byUser.set(row.userId, member);
    }
    const order = (k: StaffRoleKey) => STAFF_ROLE_KEYS.indexOf(k);
    return [...byUser.values()]
      .map((m) => ({ ...m, roles: m.roles.sort((a, b) => order(a) - order(b)) }))
      .sort((a, b) => order(a.roles[0]) - order(b.roles[0]) || a.userId.localeCompare(b.userId));
  }
}
