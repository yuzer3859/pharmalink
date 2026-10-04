import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ActivatePharmacyCommand } from './application/commands/activate-pharmacy.command';
import { AddBatchCommand } from './application/commands/add-batch.command';
import { AdjustBatchCommand } from './application/commands/adjust-batch.command';
import { ConfirmReservationCommand } from './application/commands/confirm-reservation.command';
import { CreateBranchCommand } from './application/commands/create-branch.command';
import { CreateListingCommand } from './application/commands/create-listing.command';
import { DeleteListingCommand } from './application/commands/delete-listing.command';
import { DispatchStockCommand } from './application/commands/dispatch-stock.command';
import { RegisterPharmacyCommand } from './application/commands/register-pharmacy.command';
import { ReleaseReservationCommand } from './application/commands/release-reservation.command';
import { ReserveStockCommand } from './application/commands/reserve-stock.command';
import { SetOperatingHoursCommand } from './application/commands/set-operating-hours.command';
import { UpdateBranchCommand } from './application/commands/update-branch.command';
import { UpdateListingCommand } from './application/commands/update-listing.command';
import { UpdatePharmacyProfileCommand } from './application/commands/update-pharmacy-profile.command';
import { INVENTORY_PORT } from './application/ports/inbound/inventory.port';
import { CATALOG_PORT } from './application/ports/outbound/catalog.port';
import { IDENTITY_PORT } from './application/ports/outbound/identity.port';
import { UNIT_OF_WORK } from './application/ports/outbound/unit-of-work.port';
import { GetAvailabilityQuery } from './application/queries/get-availability.query';
import { GetListingMovementsQuery } from './application/queries/get-listing-movements.query';
import { GetReservationFulfillmentQuery } from './application/queries/get-reservation-fulfillment.query';
import { ListListingsQuery } from './application/queries/list-listings.query';
import { ResolveCallerPharmacyQuery } from './application/queries/resolve-caller-pharmacy.query';
import { InventoryPortService } from './application/services/inventory-port.service';
import { BRANCH_REPOSITORY } from './domain/repositories/branch.repository';
import { LISTING_REPOSITORY } from './domain/repositories/listing.repository';
import { PHARMACY_REPOSITORY } from './domain/repositories/pharmacy.repository';
import { RESERVATION_REPOSITORY } from './domain/repositories/reservation.repository';
import { STOCK_LEDGER_REPOSITORY } from './domain/repositories/stock-ledger.repository';
import { CatalogPortAdapter } from './infrastructure/catalog/catalog-port.adapter';
import { IdentityPortAdapter } from './infrastructure/identity/identity-port.adapter';
import { PrismaBranchRepository } from './infrastructure/persistence/prisma-branch.repository';
import { PrismaListingRepository } from './infrastructure/persistence/prisma-listing.repository';
import { PrismaPharmacyRepository } from './infrastructure/persistence/prisma-pharmacy.repository';
import { PHARMACY_ANALYTICS_READ_PORT } from './application/ports/inbound/pharmacy-analytics-read.port';
import { PrismaPharmacyAnalyticsReadAdapter } from './infrastructure/persistence/prisma-pharmacy-analytics-read.adapter';
import { PrismaReservationRepository } from './infrastructure/persistence/prisma-reservation.repository';
import { PrismaStockLedgerRepository } from './infrastructure/persistence/prisma-stock-ledger.repository';
import { PrismaUnitOfWork } from './infrastructure/persistence/prisma-unit-of-work';
import { LicenseExpirySweeper } from './infrastructure/scheduling/license-expiry.sweeper';
import { ReservationTtlSweeper } from './infrastructure/scheduling/reservation-ttl.sweeper';
import { AvailabilityController } from './interface/controllers/availability.controller';
import { BranchController } from './interface/controllers/branch.controller';
import { InventoryController } from './interface/controllers/inventory.controller';
import { PharmacyController } from './interface/controllers/pharmacy.controller';

/**
 * Pharmacy & Inventory module composition root (module-04 §11). No new `APP_GUARD`s —
 * `JwtAuthGuard`/`PermissionsGuard` are already global from `IdentityModule`. Exports
 * `INVENTORY_PORT` so other modules (Module 06, later) can `imports: [PharmacyInventoryModule]`
 * and inject `IInventoryPort` directly — no HTTP round-trip to itself (§14.6). Also exports
 * `GetAvailabilityQuery` directly (module-05 §2.1) — Module 05's `IAvailabilityPort` adapter
 * injects it in-process the same way, to adapt `GET /availability/product/:id`'s read into its
 * own ranking-candidate shape without an HTTP round-trip.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [PharmacyController, BranchController, InventoryController, AvailabilityController],
  providers: [
    // Repositories
    { provide: PHARMACY_REPOSITORY, useClass: PrismaPharmacyRepository },
    { provide: BRANCH_REPOSITORY, useClass: PrismaBranchRepository },
    { provide: LISTING_REPOSITORY, useClass: PrismaListingRepository },
    { provide: STOCK_LEDGER_REPOSITORY, useClass: PrismaStockLedgerRepository },
    { provide: RESERVATION_REPOSITORY, useClass: PrismaReservationRepository },
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },

    // Cross-module ports
    { provide: CATALOG_PORT, useClass: CatalogPortAdapter },
    { provide: IDENTITY_PORT, useClass: IdentityPortAdapter },

    // Pharmacy/branch use cases
    RegisterPharmacyCommand,
    ActivatePharmacyCommand,
    UpdatePharmacyProfileCommand,
    CreateBranchCommand,
    UpdateBranchCommand,
    SetOperatingHoursCommand,
    ResolveCallerPharmacyQuery,

    // Listing/batch use cases
    CreateListingCommand,
    UpdateListingCommand,
    DeleteListingCommand,
    AddBatchCommand,
    AdjustBatchCommand,
    ListListingsQuery,
    GetListingMovementsQuery,

    // Reservation use cases
    ReserveStockCommand,
    ConfirmReservationCommand,
    ReleaseReservationCommand,
    DispatchStockCommand,
    GetReservationFulfillmentQuery,
    GetAvailabilityQuery,

    // Inbound port
    { provide: INVENTORY_PORT, useClass: InventoryPortService },
    // Inbound read contract for Module 16's operational dashboard (module-16 Work 08): provider,
    // branch and listing counts, aggregated in PostgreSQL. It can move no stock.
    { provide: PHARMACY_ANALYTICS_READ_PORT, useClass: PrismaPharmacyAnalyticsReadAdapter },

    // Scheduling
    LicenseExpirySweeper,
    ReservationTtlSweeper,
  ],
  exports: [INVENTORY_PORT, GetAvailabilityQuery, PHARMACY_ANALYTICS_READ_PORT],
})
export class PharmacyInventoryModule {}
