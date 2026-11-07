import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { PharmacyInventoryModule } from '../pharmacy-inventory/pharmacy-inventory.module';
import { SearchProjectorService } from './application/search-projector.service';
import { SearchQueryService } from './application/search-query.service';
import { SearchBootstrapJob } from './infrastructure/search-bootstrap.job';
import { SearchController } from './interface/search.controller';
import { SearchEventsHandler } from './interface/search-events.handler';

/**
 * Module 14 — Search & Discovery, minimal (Work 98, Phase 1). Postgres full-text search over
 * products and pharmacies, with nearby purchasable availability and price. Reads Modules 03 and
 * 04 only through their exported search-source ports and events; owns `search_documents` and
 * `search_offers`. Doctors, providers and diagnostics (Modules 09–12) are out of scope.
 */
@Module({
  imports: [CatalogModule, PharmacyInventoryModule],
  controllers: [SearchController],
  providers: [SearchProjectorService, SearchQueryService, SearchEventsHandler, SearchBootstrapJob],
  exports: [SearchProjectorService],
})
export class SearchModule {}
