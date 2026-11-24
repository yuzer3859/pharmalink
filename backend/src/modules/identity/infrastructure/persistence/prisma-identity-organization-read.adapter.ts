import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IIdentityOrganizationReadPort,
  OrganizationMemberView,
  OrganizationPeopleView,
} from '../../application/ports/inbound/identity-organization-read.port';

const PERSON = { id: true, email: true, phone: true, status: true } as const;

/** `IIdentityOrganizationReadPort` over `organizations`, `user_roles`, `roles` and `users`. */
@Injectable()
export class PrismaIdentityOrganizationReadAdapter implements IIdentityOrganizationReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async getOrganizationPeople(organizationId: string): Promise<OrganizationPeopleView | null> {
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        licenseNumber: true,
        licenseExpiresAt: true,
        createdAt: true,
        owner: { select: PERSON },
        userRoles: {
          select: { createdAt: true, role: { select: { key: true } }, user: { select: PERSON } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!org) return null;

    const members = new Map<string, OrganizationMemberView>();
    for (const row of org.userRoles) {
      const member = members.get(row.user.id) ?? {
        userId: row.user.id,
        email: row.user.email,
        phone: row.user.phone,
        status: row.user.status,
        roles: [],
        since: row.createdAt,
      };
      if (!member.roles.includes(row.role.key)) member.roles.push(row.role.key);
      members.set(row.user.id, member);
    }

    return {
      organizationId: org.id,
      name: org.name,
      type: org.type,
      status: org.status,
      licenseNumber: org.licenseNumber,
      licenseExpiresAt: org.licenseExpiresAt,
      createdAt: org.createdAt,
      owner: { userId: org.owner.id, email: org.owner.email, phone: org.owner.phone, status: org.owner.status },
      members: [...members.values()].map((m) => ({ ...m, roles: [...m.roles].sort() })),
    };
  }
}
