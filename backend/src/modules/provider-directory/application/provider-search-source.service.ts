import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type { ProviderType } from '../domain/provider-rules';
import type { IProviderSearchSourcePort, ProviderSearchLocation, ProviderSearchSource } from './ports/inbound/provider-search-source.port';

/** Work 162: `IProviderSearchSourcePort` over Module 09's own tables. */
@Injectable()
export class ProviderSearchSourceService implements IProviderSearchSourcePort {
  constructor(private readonly prisma: PrismaService) {}

  async providerIds(): Promise<string[]> {
    const rows = await this.prisma.healthcareProvider.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => r.id);
  }

  async provider(providerId: string): Promise<ProviderSearchSource | null> {
    const r = await this.prisma.healthcareProvider.findFirst({
      where: { id: providerId, deletedAt: null },
      include: {
        locations: { where: { deletedAt: null, isActive: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
        departments: { where: { isActive: true }, orderBy: { name: 'asc' }, select: { name: true, specialty: true } },
        serviceOfferings: { where: { isAvailable: true }, orderBy: { name: 'asc' } },
      },
    });
    if (!r) return null;
    const now = Date.now();
    return {
      providerId: r.id,
      type: r.type as ProviderType,
      displayName: r.displayName,
      nameAm: r.nameAm,
      description: r.description,
      ratingAvg: r.ratingAvg,
      ratingCount: r.ratingCount,
      eligible: r.transactingStatus === 'ACTIVE' && (!r.licenseExpiresAt || r.licenseExpiresAt.getTime() > now),
      locations: r.locations.map(
        (l): ProviderSearchLocation => ({
          locationId: l.id,
          name: l.name,
          city: l.city,
          subcity: l.subcity,
          addressLine: l.addressLine,
          lat: l.lat,
          lng: l.lng,
          phone: l.phone,
          emergencyAvailability: l.emergencyAvailability,
          isPrimary: l.isPrimary,
        }),
      ),
      departments: r.departments,
      services: r.serviceOfferings.map((s) => ({
        serviceId: s.id,
        type: s.type,
        name: s.name,
        code: s.code,
        price: s.price,
        currency: s.currency,
        durationMinutes: s.durationMinutes,
        preparationInstructions: s.preparationInstructions,
        locationId: s.locationId,
      })),
    };
  }
}
