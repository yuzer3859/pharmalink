import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IIdentityOrganizationReadPort,
  OrganizationMemberView,
  OrganizationPeopleView,
  OwnerView,
} from '../../application/ports/inbound/identity-organization-read.port';

const PERSON = { id: true, email: true, phone: true, status: true } as const;
const OWNER = {
  ...PERSON,
  createdAt: true,
  ownedOrganizations: {
    where: { type: 'PHARMACY', deletedAt: null },
    select: { id: true, name: true, status: true },
    orderBy: { createdAt: 'asc' },
  },
} as const;

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

  async listOwners(filter: { identifier?: string; status?: string }, page: number, size: number): Promise<{ items: OwnerView[]; total: number }> {
    const id = filter.identifier?.trim();
    const where: Prisma.UserWhereInput = {
      ownedOrganizations: { some: { type: 'PHARMACY', deletedAt: null } },
      ...(filter.status ? { status: filter.status as Prisma.UserWhereInput['status'] } : {}),
      ...(id ? (id.includes('@') ? { email: id.toLowerCase() } : { phone: id }) : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: OWNER, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * size, take: size }),
      this.prisma.user.count({ where }),
    ]);
    return { items: rows.map(toOwner), total };
  }

  async getOwner(userId: string): Promise<OwnerView | null> {
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: OWNER });
    return row && row.ownedOrganizations.length > 0 ? toOwner(row) : null;
  }
}

function toOwner(row: {
  id: string;
  email: string | null;
  phone: string | null;
  status: string;
  createdAt: Date;
  ownedOrganizations: Array<{ id: string; name: string; status: string }>;
}): OwnerView {
  return {
    userId: row.id,
    email: row.email,
    phone: row.phone,
    status: row.status,
    createdAt: row.createdAt,
    organizations: row.ownedOrganizations.map((o) => ({ organizationId: o.id, name: o.name, status: o.status })),
  };
}
