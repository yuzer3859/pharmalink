import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_REVIEW_HISTORY_PORT,
  ICatalogReviewHistoryPort,
  ProductStatusHistoryView,
} from '../../../catalog/application/ports/inbound/catalog-review-history.port';
import { AdminErrors } from '../../domain/errors';

/**
 * `GET /admin/catalog/review/:productId/history` (module-16 Work 33) — a product's recorded status
 * changes, oldest first, through Module 03's `CATALOG_REVIEW_HISTORY_PORT`. Every entry is a real
 * `PRODUCT_STATUS_CHANGED` audit record; nothing is inferred from the current status. Unknown or
 * deleted product → 404. Read-only: nothing is written, audited or published (Module 16 has no
 * sensitive-read audit convention).
 */
@Injectable()
export class GetCatalogReviewHistoryQuery {
  constructor(@Inject(CATALOG_REVIEW_HISTORY_PORT) private readonly history: ICatalogReviewHistoryPort) {}

  async execute(productId: string): Promise<ProductStatusHistoryView> {
    const view = await this.history.historyOf(productId);
    if (!view) throw AdminErrors.catalogProductNotFound();
    return view;
  }
}
