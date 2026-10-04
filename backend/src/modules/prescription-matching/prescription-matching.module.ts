import { Module } from '@nestjs/common';
import { PharmacyInventoryModule } from '../pharmacy-inventory/pharmacy-inventory.module';
import { ApprovePrescriptionCommand } from './application/commands/approve-prescription.command';
import { AssignVerifyingPharmacyCommand } from './application/commands/assign-verifying-pharmacy.command';
import { CheckRxGateCommand } from './application/commands/check-rx-gate.command';
import { DispenseMedicineCommand } from './application/commands/dispense-medicine.command';
import { FindMatchCommand } from './application/commands/find-match.command';
import { RejectPrescriptionCommand } from './application/commands/reject-prescription.command';
import { RematchCommand } from './application/commands/rematch.command';
import { RequestClarificationCommand } from './application/commands/request-clarification.command';
import { ReuploadPrescriptionCommand } from './application/commands/reupload-prescription.command';
import { SelectMatchCommand } from './application/commands/select-match.command';
import { UploadPrescriptionCommand } from './application/commands/upload-prescription.command';
import { CHECK_RX_GATE_PORT } from './application/ports/inbound/check-rx-gate.port';
import { DISPENSING_PORT } from './application/ports/inbound/dispensing.port';
import { MatchingPortAdapter } from './application/ports/inbound/matching-port.adapter';
import { MATCHING_PORT } from './application/ports/inbound/matching.port';
import { AVAILABILITY_PORT } from './application/ports/outbound/availability.port';
import { CATALOG_PORT } from './application/ports/outbound/catalog.port';
import { IDENTITY_PORT } from './application/ports/outbound/identity.port';
import { UNIT_OF_WORK } from './application/ports/unit-of-work.port';
import { GetMatchResultQuery } from './application/queries/get-match-result.query';
import { GetPrescriptionQuery } from './application/queries/get-prescription.query';
import { GetVerificationQueueQuery } from './application/queries/get-verification-queue.query';
import { ListPrescriptionsQuery } from './application/queries/list-prescriptions.query';
import { ResolveCallerVerificationOrgQuery } from './application/queries/resolve-caller-verification-org.query';
import { DISPENSE_LEDGER_REPOSITORY } from './domain/repositories/dispense-ledger.repository';
import { MATCH_REPOSITORY } from './domain/repositories/match.repository';
import { PRESCRIPTION_REPOSITORY } from './domain/repositories/prescription.repository';
import { VERIFICATION_REPOSITORY } from './domain/repositories/verification.repository';
import { AvailabilityPortAdapter } from './infrastructure/availability/availability-port.adapter';
import { CatalogPortAdapter } from './infrastructure/catalog/catalog-port.adapter';
import { IdentityPortAdapter } from './infrastructure/identity/identity-port.adapter';
import { PrismaDispenseLedgerRepository } from './infrastructure/persistence/prisma-dispense-ledger.repository';
import { PrismaMatchRepository } from './infrastructure/persistence/prisma-match.repository';
import { PrismaPrescriptionRepository } from './infrastructure/persistence/prisma-prescription.repository';
import { PrismaUnitOfWork } from './infrastructure/persistence/prisma-unit-of-work';
import { PrismaVerificationRepository } from './infrastructure/persistence/prisma-verification.repository';
import { MatchingController } from './interface/controllers/matching.controller';
import { PrescriptionController } from './interface/controllers/prescription.controller';
import { VerificationController } from './interface/controllers/verification.controller';

/**
 * Prescription & Matching module composition root (module-05 §11). No new `APP_GUARD`s —
 * `JwtAuthGuard`/`PermissionsGuard` are already global from `IdentityModule`. `AuditService`/
 * `OutboxService` are not re-provided here — both are `@Global()` from `SharedModule` (already
 * imported once by `AppModule`), exactly like every other feature module.
 *
 * Imports `PharmacyInventoryModule` for two direct, in-process DI dependencies (§2.1, ADR-002):
 * Module 04's already-exported `IInventoryPort` (consumed directly by `SelectMatchCommand`/
 * `RematchCommand` — not re-wrapped in another Module 05 port) and `GetAvailabilityQuery` (used
 * only by this module's own `AvailabilityPortAdapter`, never called directly by application-layer
 * commands).
 *
 * Registers the Task 8 HTTP interface layer (`PrescriptionController`/`VerificationController`/
 * `MatchingController`, module-05 §10) on top of the Task 7 application/infrastructure wiring —
 * no controller for the Rx gate/dispense ports (§7.3/§10.4: internal port methods only).
 * Exports `CHECK_RX_GATE_PORT`/`DISPENSING_PORT`/`MATCHING_PORT` so Module 06 (Orders, later) can
 * `imports: [PrescriptionMatchingModule]` and inject `ICheckRxGatePort`/`IDispensingPort`/
 * `IMatchingPort` directly — no HTTP round-trip to itself (§10.4; `MATCHING_PORT` per
 * `06-orders-spec.md` §13.1 Option B — a dedicated inbound port, not a direct export of
 * `FindMatchCommand`/`SelectMatchCommand`/`RematchCommand`, implemented by the thin
 * `MatchingPortAdapter` facade). The HTTP `MatchingController` continues injecting the three
 * commands directly, unchanged — the new port is an additional export, not a replacement for
 * any existing controller/command dependency.
 */
@Module({
  imports: [PharmacyInventoryModule],
  controllers: [PrescriptionController, VerificationController, MatchingController],
  providers: [
    // Repositories
    { provide: PRESCRIPTION_REPOSITORY, useClass: PrismaPrescriptionRepository },
    { provide: VERIFICATION_REPOSITORY, useClass: PrismaVerificationRepository },
    { provide: DISPENSE_LEDGER_REPOSITORY, useClass: PrismaDispenseLedgerRepository },
    { provide: MATCH_REPOSITORY, useClass: PrismaMatchRepository },
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },

    // Cross-module outbound ports
    { provide: CATALOG_PORT, useClass: CatalogPortAdapter },
    { provide: IDENTITY_PORT, useClass: IdentityPortAdapter },
    { provide: AVAILABILITY_PORT, useClass: AvailabilityPortAdapter },

    // Prescription lifecycle use cases
    UploadPrescriptionCommand,
    ReuploadPrescriptionCommand,
    AssignVerifyingPharmacyCommand,
    ApprovePrescriptionCommand,
    RejectPrescriptionCommand,
    RequestClarificationCommand,
    GetPrescriptionQuery,
    ListPrescriptionsQuery,
    GetVerificationQueueQuery,
    ResolveCallerVerificationOrgQuery,

    // Dispensing / Rx gate — this module's own inbound ports
    { provide: DISPENSING_PORT, useClass: DispenseMedicineCommand },
    { provide: CHECK_RX_GATE_PORT, useClass: CheckRxGateCommand },

    // Matching use cases (consume Module 04's INVENTORY_PORT directly, injected via
    // PharmacyInventoryModule above — no local re-provision needed)
    FindMatchCommand,
    SelectMatchCommand,
    RematchCommand,
    GetMatchResultQuery,

    // Matching — this module's own inbound port (06-orders-spec.md §13.1 Option B). Delegates
    // 1:1 to the three commands above; owns no ranking/reservation/retry logic of its own.
    { provide: MATCHING_PORT, useClass: MatchingPortAdapter },
  ],
  exports: [CHECK_RX_GATE_PORT, DISPENSING_PORT, MATCHING_PORT],
})
export class PrescriptionMatchingModule {}
