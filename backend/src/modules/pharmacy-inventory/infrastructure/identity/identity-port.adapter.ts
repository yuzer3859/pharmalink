import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  ApprovedPharmacyLicenseView,
  IIdentityPort,
  OrganizationView,
} from '../../application/ports/outbound/identity.port';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * `IIdentityPort` adapter (module-04 §2) — direct, in-process reads of Identity's
 * `organizations`, `user_roles` and (Work 67) `verification_requests`, never a Prisma relation
 * (ADR-002). Module 04 never writes to any of them.
 */
@Injectable()
export class IdentityPortAdapter implements IIdentityPort {
  constructor(private readonly prisma: PrismaService) {}

  async getOrganization(organizationId: string, tx?: unknown): Promise<OrganizationView | null> {
    const client = (tx as Client | undefined) ?? this.prisma;
    if (tx) {
      await (tx as Prisma.TransactionClient).$queryRaw`
        SELECT "id" FROM "organizations" WHERE "id" = ${organizationId} FOR SHARE
      `;
    }
    const org = await client.organization.findUnique({ where: { id: organizationId } });
    if (!org || org.deletedAt) {
      return null;
    }
    return {
      id: org.id,
      type: org.type,
      status: org.status,
      ownerUserId: org.ownerUserId,
      licenseNumber: org.licenseNumber,
      licenseExpiresAt: org.licenseExpiresAt,
    };
  }

  async getCurrentPharmacyLicense(
    organizationId: string,
    tx?: unknown,
  ): Promise<ApprovedPharmacyLicenseView | null> {
    const client = (tx as Client | undefined) ?? this.prisma;
    const org = await client.organization.findUnique({ where: { id: organizationId } });
    if (!org || org.deletedAt || !org.licenseNumber || !org.licenseExpiresAt) {
      return null;
    }
    const request = await client.verificationRequest.findFirst({
      where: {
        organizationId: org.id,
        userId: org.ownerUserId,
        type: 'PHARMACY_LICENSE',
        status: 'APPROVED',
        licenseNumber: org.licenseNumber,
        expiresAt: org.licenseExpiresAt,
      },
      orderBy: [{ reviewedAt: 'desc' }, { id: 'asc' }],
    });
    if (!request || !request.organizationId || !request.licenseNumber || !request.expiresAt) {
      return null;
    }
    return {
      verificationRequestId: request.id,
      organizationId: request.organizationId,
      userId: request.userId,
      licenseNumber: request.licenseNumber,
      expiresAt: request.expiresAt,
      approvedAt: request.reviewedAt,
    };
  }

  async getOrganizationOwner(organizationId: string): Promise<{ userId: string } | null> {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    return org ? { userId: org.ownerUserId } : null;
  }

  async getUserOrganizationIds(userId: string): Promise<string[]> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId, organizationId: { not: null } },
      select: { organizationId: true },
    });
    return [...new Set(roles.map((r) => r.organizationId).filter((id): id is string => id !== null))];
  }
}
