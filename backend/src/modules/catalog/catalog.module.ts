import { Module } from '@nestjs/common';
import { ChangeProductStatusCommand } from './application/commands/change-product-status.command';
import { CreateCategoryCommand } from './application/commands/create-category.command';
import { CreateManufacturerCommand } from './application/commands/create-manufacturer.command';
import { CreateProductCommand } from './application/commands/create-product.command';
import { DisableCategoryCommand } from './application/commands/disable-category.command';
import { UpdateCategoryCommand } from './application/commands/update-category.command';
import { UpdateManufacturerCommand } from './application/commands/update-manufacturer.command';
import { UpdateProductCommand } from './application/commands/update-product.command';
import { UNIT_OF_WORK } from './application/ports/unit-of-work.port';
import { GetCategoryTreeQuery } from './application/queries/get-category-tree.query';
import { GetProductQuery } from './application/queries/get-product.query';
import { ListCategoriesAdminQuery } from './application/queries/list-categories-admin.query';
import { ListManufacturersQuery } from './application/queries/list-manufacturers.query';
import { ListProductsByCategoryQuery } from './application/queries/list-products-by-category.query';
import { SearchProductsQuery } from './application/queries/search-products.query';
import { CATEGORY_REPOSITORY } from './domain/repositories/category.repository';
import { MANUFACTURER_REPOSITORY } from './domain/repositories/manufacturer.repository';
import { PRODUCT_REPOSITORY } from './domain/repositories/product.repository';
import { PrismaCategoryRepository } from './infrastructure/persistence/prisma-category.repository';
import { PrismaManufacturerRepository } from './infrastructure/persistence/prisma-manufacturer.repository';
import { PrismaProductRepository } from './infrastructure/persistence/prisma-product.repository';
import { CATALOG_ANALYTICS_READ_PORT } from './application/ports/inbound/catalog-analytics-read.port';
import { PrismaCatalogAnalyticsReadAdapter } from './infrastructure/persistence/prisma-catalog-analytics-read.adapter';
import { CATALOG_ADMIN_READ_PORT } from './application/ports/inbound/catalog-admin-read.port';
import { PrismaCatalogAdminReadAdapter } from './infrastructure/persistence/prisma-catalog-admin-read.adapter';
import {
  CATALOG_REVIEW_APPROVAL_PORT,
  CatalogReviewApprovalPortAdapter,
} from './application/ports/inbound/catalog-review-approval.port';
import {
  CATALOG_REVIEW_SUBMISSION_PORT,
  CatalogReviewSubmissionPortAdapter,
} from './application/ports/inbound/catalog-review-submission.port';
import { PrismaUnitOfWork } from './infrastructure/persistence/prisma-unit-of-work';
import { AdminCatalogController } from './interface/controllers/admin-catalog.controller';
import { CatalogController } from './interface/controllers/catalog.controller';

/**
 * Catalog module composition root (module-03 §10). No new `APP_GUARD`s — `JwtAuthGuard` and
 * `PermissionsGuard` are already global from `IdentityModule` (§2, §7.2).
 */
@Module({
  controllers: [CatalogController, AdminCatalogController],
  providers: [
    // Repositories
    { provide: PRODUCT_REPOSITORY, useClass: PrismaProductRepository },
    { provide: CATEGORY_REPOSITORY, useClass: PrismaCategoryRepository },
    { provide: MANUFACTURER_REPOSITORY, useClass: PrismaManufacturerRepository },
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },

    // Inbound read contract for Module 16's operational dashboard (module-16 Work 08): product
    // counts by status, aggregated in PostgreSQL.
    { provide: CATALOG_ANALYTICS_READ_PORT, useClass: PrismaCatalogAnalyticsReadAdapter },
    // Inbound read contract for Module 16's catalogue review list (module-16 Work 09): products
    // in one lifecycle status, paged, each with the transitions `ProductStatusPolicy` allows.
    // Read-only — the status writer stays `ChangeProductStatusCommand` behind this module's route.
    { provide: CATALOG_ADMIN_READ_PORT, useClass: PrismaCatalogAdminReadAdapter },
    // Inbound approval contract for Module 16's catalogue review (module-16 Work 28): PENDING_REVIEW
    // -> ACTIVE only, through `ChangeProductStatusCommand` itself — not a second status writer.
    { provide: CATALOG_REVIEW_APPROVAL_PORT, useClass: CatalogReviewApprovalPortAdapter },
    // Inbound submission contract for Module 16's catalogue review (module-16 Work 29): DRAFT ->
    // PENDING_REVIEW only, through `ChangeProductStatusCommand` itself — not a second status writer.
    // These four ports are the only things this module exports.
    { provide: CATALOG_REVIEW_SUBMISSION_PORT, useClass: CatalogReviewSubmissionPortAdapter },

    // Application use cases — products
    CreateProductCommand,
    UpdateProductCommand,
    ChangeProductStatusCommand,
    SearchProductsQuery,
    GetProductQuery,
    ListProductsByCategoryQuery,

    // Application use cases — categories
    CreateCategoryCommand,
    UpdateCategoryCommand,
    DisableCategoryCommand,
    GetCategoryTreeQuery,
    ListCategoriesAdminQuery,

    // Application use cases — manufacturers
    CreateManufacturerCommand,
    UpdateManufacturerCommand,
    ListManufacturersQuery,
  ],
  exports: [CATALOG_ANALYTICS_READ_PORT, CATALOG_ADMIN_READ_PORT, CATALOG_REVIEW_APPROVAL_PORT, CATALOG_REVIEW_SUBMISSION_PORT],
})
export class CatalogModule {}
