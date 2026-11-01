import { Injectable } from '@nestjs/common';
import { Organization, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IOrganizationRepository,
  OrganizationRecord,
  RoleRecord,
} from '../../domain/repositories/organization.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toRecord(org: Organization): OrganizationRecord {
  return {
    id: org.id,
    type: org.type,
    name: org.name,
    status: org.status,
    ownerUserId: org.ownerUserId,
    applicationKey: org.applicationKey,
    createdAt: org.createdAt,
  };
}

@Injectable()
export class PrismaOrganizationRepository implements IOrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByOwnerAndApplicationKey(
    ownerUserId: string,
    applicationKey: string,
    tx?: unknown,
  ): Promise<OrganizationRecord | null> {
    const client = (tx as Client) ?? this.prisma;
    const org = await client.organization.findUnique({
      where: { ownerUserId_applicationKey: { ownerUserId, applicationKey } },
    });
    return org ? toRecord(org) : null;
  }

  async findRoleByKey(roleKey: string, tx?: unknown): Promise<RoleRecord | null> {
    const client = (tx as Client) ?? this.prisma;
    const role = await client.role.findUnique({ where: { key: roleKey }, select: { id: true, key: true, scope: true } });
    return role;
  }

  async createPendingPharmacy(
    input: { ownerUserId: string; name: string; applicationKey: string },
    tx: unknown,
  ): Promise<OrganizationRecord> {
    const org = await (tx as Client).organization.create({
      data: {
        type: 'PHARMACY',
        status: 'PENDING_APPROVAL',
        name: input.name,
        ownerUserId: input.ownerUserId,
        applicationKey: input.applicationKey,
        licenseNumber: null,
        licenseExpiresAt: null,
      },
    });
    return toRecord(org);
  }

  async addMembership(
    input: { userId: string; roleId: string; organizationId: string; assignedBy: string },
    tx: unknown,
  ): Promise<{ assignmentId: string }> {
    const row = await (tx as Client).userRole.create({ data: input, select: { id: true } });
    return { assignmentId: row.id };
  }
}
