import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../shared/events/event-bus.service';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { CatalogEventType } from '../../catalog/domain/events';
import {
  CATALOG_SEARCH_SOURCE_PORT,
  ICatalogSearchSourcePort,
} from '../../catalog/application/ports/inbound/catalog-search-source.port';
import { PharmacyInventoryEventType } from '../../pharmacy-inventory/domain/events';
import { SearchProjectorService } from '../application/search-projector.service';

type Payload = Record<string, unknown>;
const str = (p: Payload, key: string): string | null => (typeof p[key] === 'string' ? (p[key] as string) : null);

/**
 * Work 98: keeps the search projections in step through the outbox (module-14 §7). Every event
 * triggers an idempotent refresh from the owning module's search-source port, so duplicates and
 * out-of-order delivery converge. Failures are logged, never thrown into the bus; a reindex
 * (`npm run search:reindex`) repairs anything missed.
 */
@Injectable()
export class SearchEventsHandler implements OnModuleInit {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(CATALOG_SEARCH_SOURCE_PORT) private readonly catalog: ICatalogSearchSourcePort,
    private readonly projector: SearchProjectorService,
  ) {
    this.logger.setContext(SearchEventsHandler.name);
  }

  onModuleInit(): void {
    const product = (e: DomainEvent<Payload>) => this.run(e, async (p) => {
      const id = str(p, 'productId');
      if (id) await this.projector.refreshProduct(id);
    });
    for (const type of [
      CatalogEventType.ProductCreated,
      CatalogEventType.ProductUpdated,
      CatalogEventType.ProductClassificationChanged,
      CatalogEventType.ProductStatusChanged,
    ]) {
      this.bus.subscribe<Payload>(type, product);
    }
    this.bus.subscribe<Payload>(CatalogEventType.CategoryUpdated, (e) =>
      this.run(e, async (p) => {
        const id = str(p, 'categoryId');
        if (!id) return;
        for (const productId of await this.catalog.productsInCategory(id)) await this.projector.refreshProduct(productId);
      }),
    );

    this.bus.subscribe<Payload>(PharmacyInventoryEventType.ListingCreated, (e) =>
      this.run(e, async (p) => {
        const id = str(p, 'catalogProductId');
        if (id) await this.projector.refreshOffers(id);
      }),
    );
    for (const type of [
      PharmacyInventoryEventType.ListingDisabled,
      PharmacyInventoryEventType.PriceChanged,
      PharmacyInventoryEventType.StockReceived,
      PharmacyInventoryEventType.StockReserved,
      PharmacyInventoryEventType.StockReleased,
      PharmacyInventoryEventType.StockDispatched,
    ]) {
      this.bus.subscribe<Payload>(type, (e) =>
        this.run(e, async (p) => {
          const id = str(p, 'listingId');
          if (id) await this.projector.refreshListing(id);
        }),
      );
    }
    for (const type of [PharmacyInventoryEventType.PharmacyActivated, PharmacyInventoryEventType.PharmacySuspended]) {
      this.bus.subscribe<Payload>(type, (e) =>
        this.run(e, async (p) => {
          const id = str(p, 'pharmacyId');
          if (id) await this.projector.refreshPharmacy(id);
        }),
      );
    }
  }

  private async run(event: DomainEvent<Payload>, work: (payload: Payload) => Promise<void>): Promise<void> {
    try {
      await work((event?.payload ?? {}) as Payload);
    } catch (err) {
      this.logger.error({
        message: 'Search projection update failed; a reindex repairs it',
        eventType: event?.type ?? null,
        eventId: event?.id ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
