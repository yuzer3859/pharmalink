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
    licenseNumber: org.licenseNumber,
    licenseExpiresAt: org.licenseExpiresAt,
    createdAt: org.createdAt,
    deletedAt: org.deletedAt,
  };
}

@Injectable()
export class PrismaOrganizationRepository implements IOrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: unknown): Promise<OrganizationRecord | null> {
    const client = (tx as Client) ?? this.prisma;
    const org = await client.organization.findUnique({ where: { id } });
    return org ? toRecord(org) : null;
  }

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

  async recordApprovedLicense(
    input: { organizationId: string; ownerUserId: string; licenseNumber: string; licenseExpiresAt: Date },
    tx: unknown,
  ): Promise<boolean> {
    const result = await (tx as Client).organization.updateMany({
      where: { id: input.organizationId, ownerUserId: input.ownerUserId, type: 'PHARMACY', deletedAt: null },
      data: { status: 'ACTIVE', licenseNumber: input.licenseNumber, licenseExpiresAt: input.licenseExpiresAt },
    });
    return result.count === 1;
  }

  async rejectPendingApplication(organizationId: string, tx: unknown): Promise<boolean> {
    const result = await (tx as Client).organization.updateMany({
      where: { id: organizationId, status: 'PENDING_APPROVAL', deletedAt: null },
      data: { status: 'REJECTED' },
    });
    return result.count === 1;
  }

  async suspendForExpiredLicense(
    input: { organizationId: string; licenseNumber: string | null; licenseExpiresAt: Date; now: Date },
    tx: unknown,
  ): Promise<boolean> {
    if (input.licenseExpiresAt.getTime() > input.now.getTime()) return false;
    const result = await (tx as Client).organization.updateMany({
      where: {
        id: input.organizationId,
        type: 'PHARMACY',
        status: 'ACTIVE',
        licenseNumber: input.licenseNumber,
        licenseExpiresAt: input.licenseExpiresAt,
      },
      data: { status: 'SUSPENDED' },
    });
    return result.count === 1;
  }
}
