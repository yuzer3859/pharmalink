import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type { ProviderStatus, ProviderType } from '../domain/provider-rules';
import type { IProviderAdminReadPort, ProviderListItem, ProviderRecord } from './ports/inbound/provider-admin-read.port';

/**
 * `ILIKE` with the user's text taken literally: Prisma's `contains` passes `%`, `_` and `\`
 * through as wildcards, so they are escaped first.
 */
function containsInsensitive(q: string): Prisma.StringFilter {
  return { contains: q.replace(/[\\%_]/g, (c) => `\\${c}`), mode: 'insensitive' };
}

/** Work 160: `IProviderAdminReadPort` over `healthcare_providers` and its locations, departments and services. */
@Injectable()
export class ProviderAdminReadService implements IProviderAdminReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: { q?: string; type?: ProviderType; status?: ProviderStatus }, page: number, size: number) {
    const q = filter.q?.trim();
    const where: Prisma.HealthcareProviderWhereInput = {
      deletedAt: null,
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.status ? { transactingStatus: filter.status } : {}),
      ...(q ? { OR: [{ displayName: containsInsensitive(q) }, { nameEn: containsInsensitive(q) }, { nameAm: containsInsensitive(q) }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.healthcareProvider.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * size,
        take: size,
        include: { locations: { where: { deletedAt: null }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1, select: { city: true } } },
      }),
      this.prisma.healthcareProvider.count({ where }),
    ]);
    return {
      items: rows.map(
        (r): ProviderListItem => ({
          providerId: r.id,
          organizationId: r.organizationId,
          type: r.type as ProviderType,
          displayName: r.displayName,
          status: r.transactingStatus as ProviderStatus,
          licenseStatus: r.licenseStatus,
          licenseExpiresAt: r.licenseExpiresAt,
          city: r.locations[0]?.city ?? null,
          createdAt: r.createdAt,
        }),
      ),
      total,
    };
  }

  async get(providerId: string): Promise<ProviderRecord | null> {
    const r = await this.prisma.healthcareProvider.findFirst({
      where: { id: providerId, deletedAt: null },
      include: {
        locations: { where: { deletedAt: null }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
        departments: { orderBy: { name: 'asc' } },
        serviceOfferings: { orderBy: { name: 'asc' } },
      },
    });
    if (!r) return null;
    return {
      providerId: r.id,
      organizationId: r.organizationId,
      type: r.type as ProviderType,
      displayName: r.displayName,
      status: r.transactingStatus as ProviderStatus,
      licenseStatus: r.licenseStatus,
      licenseExpiresAt: r.licenseExpiresAt,
      city: r.locations[0]?.city ?? null,
      createdAt: r.createdAt,
      nameEn: r.nameEn,
      nameAm: r.nameAm,
      description: r.description,
      website: r.website,
      contactPhone: r.contactPhone,
      contactEmail: r.contactEmail,
      ratingAvg: r.ratingAvg,
      ratingCount: r.ratingCount,
      locations: r.locations.map((l) => ({
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
        isActive: l.isActive,
      })),
      departments: r.departments.map((d) => ({ departmentId: d.id, name: d.name, specialty: d.specialty, isActive: d.isActive })),
      services: r.serviceOfferings.map((s) => ({ serviceId: s.id, type: s.type, name: s.name, price: s.price, currency: s.currency, isAvailable: s.isAvailable })),
    };
  }
}
