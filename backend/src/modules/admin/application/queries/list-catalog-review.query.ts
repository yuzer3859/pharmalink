import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_ADMIN_READ_PORT,
  CatalogAdminProductPage,
  ICatalogAdminReadPort,
  ProductStatus,
  ProductType,
} from '../../../catalog/application/ports/inbound/catalog-admin-read.port';

export const DEFAULT_CATALOG_REVIEW_PAGE = 1;
export const DEFAULT_CATALOG_REVIEW_PAGE_SIZE = 20;
/** Same ceiling as the other admin lists — a page is a screen, not an export. */
export const MAX_CATALOG_REVIEW_PAGE_SIZE = 100;
/**
 * `DRAFT` is the state Module 03 creates every product in and the only one `ACTIVE` can be
 * reached from on first publication (Module 03's status policy): products awaiting an
 * administrator's decision to go live. It is the default, not the only answer.
 */
export const DEFAULT_CATALOG_REVIEW_STATUS = ProductStatus.DRAFT;

export interface ListCatalogReviewInput {
  status?: ProductStatus;
  type?: ProductType;
  q?: string;
  page?: number;
  size?: number;
}

/**
 * `GET /admin/catalog/review` (module-16 Work 09) — the catalogue products an administrator
 * cannot otherwise find: every public read (`/catalog/products`, `/catalog/categories/:id/
 * products`) returns `ACTIVE` only, and Module 03's admin surface reads one product by id.
 *
 * ## It is a list, not a workflow
 *
 * Module 03 has no proposal, submission or reviewer assignment, and `PENDING_REVIEW` is reserved
 * and unreachable. So there is nothing here to approve or reject: the decision on a product is a
 * status transition, and Module 03 already serves it — `POST /admin/catalog/products/:id/status`,
 * state-machine-checked, audited and evented in one transaction. Each row carries the
 * `allowedTransitions` Module 03 computes, so an administrator sees which decisions that route
 * will accept without Module 16 holding a copy of the state machine.
 *
 * The rows are Module 03's projections through `ICatalogAdminReadPort`; this query only defaults
 * and clamps the paging and the status.
 */
@Injectable()
export class ListCatalogReviewQuery {
  constructor(@Inject(CATALOG_ADMIN_READ_PORT) private readonly catalog: ICatalogAdminReadPort) {}

  async execute(input: ListCatalogReviewInput): Promise<CatalogAdminProductPage> {
    const page =
      input.page !== undefined && Number.isFinite(input.page) && input.page > 0
        ? Math.floor(input.page)
        : DEFAULT_CATALOG_REVIEW_PAGE;
    const size =
      input.size !== undefined && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_CATALOG_REVIEW_PAGE_SIZE)
        : DEFAULT_CATALOG_REVIEW_PAGE_SIZE;

    return this.catalog.listProducts(
      { status: input.status ?? DEFAULT_CATALOG_REVIEW_STATUS, type: input.type, q: input.q },
      page,
      size,
    );
  }
}
