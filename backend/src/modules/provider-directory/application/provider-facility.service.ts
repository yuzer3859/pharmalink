import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { narrowToSelectedOrganization } from '../../../shared/http/selected-organization';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  IDENTITY_ORGANIZATION_READ_PORT,
  type IIdentityOrganizationReadPort,
} from '../../identity/application/ports/inbound/identity-organization-read.port';
import type { ProviderType } from '../domain/provider-rules';
import type { FacilitySummary, IProviderFacilityPort } from './ports/inbound/provider-facility.port';
import { FACILITY_ADMIN_ROLES } from './provider-portal.service';

const SELECT = Prisma.validator<Prisma.HealthcareProviderSelect>()({
  id: true,
  type: true,
  displayName: true,
  transactingStatus: true,
  licenseExpiresAt: true,
  locations: { where: { deletedAt: null, isActive: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1, select: { city: true, lat: true, lng: true } },
});

function toSummary(r: {
  id: string;
  type: string;
  displayName: string;
  transactingStatus: string;
  licenseExpiresAt: Date | null;
  locations: Array<{ city: string | null; lat: number | null; lng: number | null }>;
}): FacilitySummary {
  const main = r.locations[0];
  return {
    city: main?.city ?? null,
    lat: main?.lat ?? null,
    lng: main?.lng ?? null,
    providerId: r.id,
    type: r.type as ProviderType,
    displayName: r.displayName,
    status: r.transactingStatus,
    eligible: r.transactingStatus === 'ACTIVE' && (!r.licenseExpiresAt || r.licenseExpiresAt.getTime() > Date.now()),
  };
}

/** Work 166: `IProviderFacilityPort` over Module 09's own tables and Module 01's role read. */
@Injectable()
export class ProviderFacilityService implements IProviderFacilityPort {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDENTITY_ORGANIZATION_READ_PORT) private readonly organizations: IIdentityOrganizationReadPort,
  ) {}

  async callerFacility(userId: string): Promise<FacilitySummary | null> {
    const organizationIds = narrowToSelectedOrganization(await this.organizations.organizationIdsWhereUserHolds(userId, FACILITY_ADMIN_ROLES));
    if (organizationIds.length === 0) return null;
    const row = await this.prisma.healthcareProvider.findFirst({
      where: { organizationId: { in: organizationIds }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: SELECT,
    });
    return row ? toSummary(row) : null;
  }

  async departmentOf(providerId: string, departmentId: string) {
    const row = await this.prisma.department.findFirst({ where: { id: departmentId, providerId }, select: { id: true, name: true } });
    return row ? { departmentId: row.id, name: row.name } : null;
  }

  async summaries(providerIds: string[]): Promise<FacilitySummary[]> {
    if (providerIds.length === 0) return [];
    const rows = await this.prisma.healthcareProvider.findMany({ where: { id: { in: providerIds }, deletedAt: null }, select: SELECT });
    return rows.map(toSummary);
  }

  async locationOf(locationId: string) {
    const row = await this.prisma.providerLocation.findFirst({
      where: { id: locationId, deletedAt: null, isActive: true, provider: { deletedAt: null } },
      select: { id: true, providerId: true, name: true, city: true, lat: true, lng: true },
    });
    return row ? { locationId: row.id, providerId: row.providerId, name: row.name, city: row.city, lat: row.lat, lng: row.lng } : null;
  }
}
