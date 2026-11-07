import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { Public } from '../../../shared/rbac/public.decorator';
import { DEFAULT_RADIUS_KM, GeoFilter, SearchQueryService } from '../application/search-query.service';
import { SearchMedicinesQueryDto, SearchOffersQueryDto, SearchPharmaciesQueryDto } from './search.dto';

function geoOf(dto: { lat?: number; lng?: number; radiusKm?: number }): GeoFilter | undefined {
  const hasLat = dto.lat !== undefined;
  const hasLng = dto.lng !== undefined;
  if (hasLat !== hasLng) {
    throw new ApiException(ErrorCode.VALIDATION_ERROR, 'lat and lng must be given together.', { field: hasLat ? 'lng' : 'lat' });
  }
  return hasLat ? { lat: dto.lat!, lng: dto.lng!, radiusKm: dto.radiusKm ?? DEFAULT_RADIUS_KM } : undefined;
}

/**
 * Work 98: Module 14's public search API (module-14 §9, minimal). No sign-in: discovery is open,
 * like the catalogue. Results come from Search's own projections; buying re-verifies everything.
 */
@Public()
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchQueryService) {}

  /** Medicines and health products by English or Amharic name, with nearby availability. */
  @Get('medicines')
  medicines(@Query() dto: SearchMedicinesQueryDto) {
    return this.search.medicines({
      q: dto.q,
      categoryId: dto.categoryId,
      rx: dto.rx,
      geo: geoOf(dto),
      availableOnly: dto.availableOnly,
      page: dto.page ?? 1,
      size: dto.size ?? 20,
    });
  }

  /** Where a product can be bought now: nearest first with a location, else cheapest. */
  @Get('medicines/:productId/pharmacies')
  async offers(@Param('productId', new ParseUUIDPipe()) productId: string, @Query() dto: SearchOffersQueryDto) {
    return { items: await this.search.offers(productId, geoOf(dto), dto.limit ?? 20) };
  }

  /** Transacting pharmacies by name, branch or city; nearest first with a location. */
  @Get('pharmacies')
  pharmacies(@Query() dto: SearchPharmaciesQueryDto) {
    return this.search.pharmacies({ q: dto.q, geo: geoOf(dto), page: dto.page ?? 1, size: dto.size ?? 20 });
  }
}
