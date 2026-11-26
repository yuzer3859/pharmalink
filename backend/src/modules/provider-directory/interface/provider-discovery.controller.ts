import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Public } from '../../../shared/rbac/public.decorator';
import { ProviderErrors } from '../domain/provider-rules';
import { ProviderSearchSourceService } from '../application/provider-search-source.service';
import { ProviderAdminReadService } from '../application/provider-admin-read.service';

/**
 * Work 162: public discovery of a healthcare provider (module-09 §8.1). No sign-in, like the
 * catalogue. Only an eligible provider is shown; searching providers and their services is
 * `GET /search/providers` and `GET /search/services` (Module 14).
 *
 *     GET /providers/:id            profile, active locations with hours and facilities, open departments, available services
 *     GET /providers/:id/services   its available tests, imaging and packages
 */
@Public()
@Controller('providers')
export class ProviderDiscoveryController {
  constructor(
    private readonly source: ProviderSearchSourceService,
    private readonly reads: ProviderAdminReadService,
  ) {}

  @Get(':providerId')
  async get(@Param('providerId', new ParseUUIDPipe()) providerId: string) {
    const source = await this.source.provider(providerId);
    if (!source?.eligible) throw ProviderErrors.notFound();
    const record = await this.reads.get(providerId);
    if (!record) throw ProviderErrors.notFound();
    return {
      providerId: record.providerId,
      type: record.type,
      displayName: record.displayName,
      nameEn: record.nameEn,
      nameAm: record.nameAm,
      description: record.description,
      website: record.website,
      contactPhone: record.contactPhone,
      contactEmail: record.contactEmail,
      ratingAvg: record.ratingAvg,
      ratingCount: record.ratingCount,
      locations: record.locations
        .filter((l) => l.isActive)
        .map((l) => ({
          locationId: l.locationId,
          name: l.name,
          city: l.city,
          subcity: l.subcity,
          addressLine: l.addressLine,
          lat: l.lat,
          lng: l.lng,
          phone: l.phone,
          emergencyAvailability: l.emergencyAvailability,
          isPrimary: l.isPrimary,
          hours: l.hours,
          facilities: l.facilities,
        })),
      departments: record.departments.filter((d) => d.isActive).map((d) => ({ departmentId: d.departmentId, name: d.name, specialty: d.specialty, description: d.description, contactPhone: d.contactPhone })),
      services: source.services,
    };
  }

  @Get(':providerId/services')
  async services(@Param('providerId', new ParseUUIDPipe()) providerId: string) {
    const source = await this.source.provider(providerId);
    if (!source?.eligible) throw ProviderErrors.notFound();
    return { items: source.services };
  }
}
