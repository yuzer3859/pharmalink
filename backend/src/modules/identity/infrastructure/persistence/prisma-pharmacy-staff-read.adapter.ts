import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IPharmacyStaffReadPort, PharmacyStaffMember } from '../../application/services/pharmacy-staff.service';

/** Work 113: an organisation's members and their roles there. No password, MFA or session data. */
@Injectable()
export class PrismaPharmacyStaffReadAdapter implements IPharmacyStaffReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listMembers(organizationId: string): Promise<PharmacyStaffMember[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        role: { select: { key: true, name: true } },
        user: { select: { id: true, email: true, phone: true, status: true, deletedAt: true } },
      },
    });
    const members = new Map<string, PharmacyStaffMember>();
    for (const row of rows) {
      if (row.user.deletedAt) continue;
      const member = members.get(row.user.id) ?? { userId: row.user.id, email: row.user.email, phone: row.user.phone, status: row.user.status, roles: [] };
      member.roles.push({ roleKey: row.role.key, roleName: row.role.name, assignedAt: row.createdAt });
      members.set(row.user.id, member);
    }
    return [...members.values()];
  }
}
