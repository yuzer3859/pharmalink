import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CatalogModule } from '../catalog/catalog.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { IdentityModule } from '../identity/identity.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentModule } from '../payment/payment.module';
import { PharmacyInventoryModule } from '../pharmacy-inventory/pharmacy-inventory.module';
import { ApproveVerificationCommand } from './application/commands/approve-verification.command';
import { AssignRoleCommand } from './application/commands/assign-role.command';
import { ReinstateUserCommand } from './application/commands/reinstate-user.command';
import { RejectVerificationCommand } from './application/commands/reject-verification.command';
import { ResolveCodDisputeCommand } from './application/commands/resolve-cod-dispute.command';
import { RevokeRoleCommand } from './application/commands/revoke-role.command';
import { RollbackConfigCommand } from './application/commands/rollback-config.command';
import { SuspendUserCommand } from './application/commands/suspend-user.command';
import { ToggleFeatureFlagCommand } from './application/commands/toggle-feature-flag.command';
import { UpdateConfigCommand } from './application/commands/update-config.command';
import { GetAnalyticsOverviewQuery } from './application/queries/get-analytics-overview.query';
import { GetConfigQuery } from './application/queries/get-config.query';
import { GetFeatureFlagsQuery } from './application/queries/get-feature-flags.query';
import { GetFinanceOverviewQuery } from './application/queries/get-finance-overview.query';
import { GetFinancePaymentQuery } from './application/queries/get-finance-payment.query';
import { GetAuditEntryQuery } from './application/queries/get-audit-entry.query';
import { GetCodDisputeQuery } from './application/queries/get-cod-dispute.query';
import { GetUserQuery } from './application/queries/get-user.query';
import { GetUserRolesQuery } from './application/queries/get-user-roles.query';
import { GetVerificationQuery } from './application/queries/get-verification.query';
import { ListAuditQuery } from './application/queries/list-audit.query';
import { ListCatalogReviewQuery } from './application/queries/list-catalog-review.query';
import { ListCodDisputesQuery } from './application/queries/list-cod-disputes.query';
import { ListFinancePaymentsQuery } from './application/queries/list-finance-payments.query';
import { ListFinanceRefundsQuery } from './application/queries/list-finance-refunds.query';
import { ListRoleCatalogueQuery } from './application/queries/list-role-catalogue.query';
import { ListUsersQuery } from './application/queries/list-users.query';
import { ListVerificationQueueQuery } from './application/queries/list-verification-queue.query';
import { FEATURE_FLAG_REPOSITORY } from './domain/repositories/feature-flag.repository';
import { PLATFORM_CONFIG_REPOSITORY } from './domain/repositories/platform-config.repository';
import { ConfigOverrideLoader } from './infrastructure/config/config-override.loader';
import { PrismaFeatureFlagRepository } from './infrastructure/persistence/prisma-feature-flag.repository';
import { PrismaPlatformConfigRepository } from './infrastructure/persistence/prisma-platform-config.repository';
import { AdminAccountsController } from './interface/controllers/admin-accounts.controller';
import { AdminAnalyticsController } from './interface/controllers/admin-analytics.controller';
import { AdminAuditController } from './interface/controllers/admin-audit.controller';
import { AdminCatalogReviewController } from './interface/controllers/admin-catalog-review.controller';
import { AdminCodDisputesController } from './interface/controllers/admin-cod-disputes.controller';
import { AdminConfigController } from './interface/controllers/admin-config.controller';
import { AdminFeatureFlagController } from './interface/controllers/admin-feature-flag.controller';
import { AdminFinanceController } from './interface/controllers/admin-finance.controller';
import { AdminRolesController } from './interface/controllers/admin-roles.controller';
import { AdminVerificationsController } from './interface/controllers/admin-verifications.controller';

/**
 * Module 16 — Admin & Platform Management. Work 01: platform configuration and feature flags.
 * Work 02: verification management. Work 03: user & account management. Work 04: role
 * assignment. Work 05: audit explorer. Work 06: COD dispute management. Work 07: finance
 * oversight. Work 08: operational analytics. Work 09: catalogue review list.
 *
 * ## The module's shape, and why it is this small
 *
 * The design calls Admin "orchestration, not ownership", and Work 01 is the part of Module 16 that
 * genuinely *does* own something: `PlatformConfig` and `FeatureFlag` are Admin's aggregates, not
 * references to somebody else's. Works 02 and 03 are orchestration surfaces, and they own
 * nothing: the verification queue and the account list read and act through
 * `IDENTITY_ADMIN_PORT`, the contract `IdentityModule` exports for exactly that, and never touch
 * `verification_requests`, `users` or `user_roles`. Work 05 reads the shared hash-chained
 * audit trail through `AUDIT_READ_PORT` — `AuditModule`'s own read boundary — and writes nothing
 * to it. Work 06 reads and resolves Module 08's COD disputes through `COD_DISPUTE_ADMIN_PORT`
 * and holds no dispute of its own. Work 07 reads Module 07's payments, refunds and settlement
 * totals through `FINANCE_OVERSIGHT_PORT` and Module 08's COD summary through
 * `COD_FINANCE_READ_PORT`, and moves nothing. Work 08 counts — accounts, catalogue, providers,
 * orders, delivery jobs and drivers — through one read port per owning module, and keeps no
 * snapshot table of its own (the design's `analytics_snapshots` stays unused: the counts are
 * `GROUP BY`s the owners run on demand). Work 09 lists catalogue products by lifecycle status
 * through `CATALOG_ADMIN_READ_PORT` and changes none: Module 03 has no proposal workflow, and
 * the status transition stays on Module 03's own audited route. Everything else the design
 * lists — impersonation, moderation, payouts, the cross-module `DisputeCase`, KPI/period
 * dashboards — is a later work and none of it is here.
 *
 * ## How configuration reaches the modules that read it
 *
 * Nothing in this module talks to Orders, Delivery or Payment, and nothing writes to their tables.
 * The handover is one shared object:
 *
 *     UpdateConfigCommand ─writes→ platform_configs
 *                         └─refresh→ ConfigOverrideRegistry (shared/config, in memory)
 *                                          ↑
 *     feature module → IConfigPort → PlatformConfigResolver ─falls back→ AppConfigService (env)
 *
 * The registry lives in `shared/config` rather than here, because the *reader* is shared
 * infrastructure — putting it in this module would make `AppConfigModule` depend on a feature
 * module to resolve a value. Module 16 fills it; nobody depends on Module 16 to read it. If this
 * module were removed tomorrow, the registry would stay empty and every lookup would resolve from
 * the environment exactly as it did before.
 *
 * That is also why no existing module changed. `IConfigPort`'s doc comment has said since Phase 0
 * that "Module 16 (Admin) will later provide a DB-backed implementation … without any feature
 * module changing its code", and that promise is kept literally: the twenty-four call sites that
 * read `CONFIG_PORT` are untouched.
 *
 * ## Deliberately absent
 *
 * - **A second Redis client, and any Redis at all.** §11 asks for a correct cache, not a
 *   distributed configuration system. `ConfigOverrideLoader` reloads the whole snapshot from
 *   Postgres on a 30-second timer and immediately after a publish, which bounds staleness by
 *   construction — there is no invalidation message that can be missed.
 * - **Maker-checker.** §14 of the brief says not to add it without an existing contract requiring
 *   it, and there is none; `ApprovalRequest` is scaffolded in the schema with a `CONFIG_CHANGE`
 *   entity type, waiting for the work that builds the workflow.
 * - **Percentage rollout.** The flag table carries `rolloutPercent` and `targetRules` from Phase 0
 *   and this work writes neither, because no evaluator exists that could honour them.
 * - **`delivery.feeZones`** and the `redis` namespace — see `ConfigCatalogue` for why each is
 *   outside the governable surface.
 */
@Module({
  // `IdentityModule` for `@CurrentUser` on the admin controllers, the same import every other
  // module's HTTP surface takes — and, since Work 02, for `IDENTITY_ADMIN_PORT`. `DeliveryModule`
  // for `COD_DISPUTE_ADMIN_PORT` (Work 06) and `COD_FINANCE_READ_PORT` (Work 07), and nothing
  // else of it. `PaymentModule` for `FINANCE_OVERSIGHT_PORT` (Work 07) alone. `CatalogModule`,
  // `PharmacyInventoryModule` and `OrdersModule` each for their `*_ANALYTICS_READ_PORT` (Work 08)
  // and nothing else — `CatalogModule` also for `CATALOG_ADMIN_READ_PORT` (Work 09).
  // `ScheduleModule.forRoot()` activates the loader's refresh tick; registered here rather than
  // relied upon from another module's registration, for the reason `DeliveryModule` gives.
  imports: [
    IdentityModule,
    DeliveryModule,
    PaymentModule,
    CatalogModule,
    PharmacyInventoryModule,
    OrdersModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    { provide: PLATFORM_CONFIG_REPOSITORY, useClass: PrismaPlatformConfigRepository },
    { provide: FEATURE_FLAG_REPOSITORY, useClass: PrismaFeatureFlagRepository },

    UpdateConfigCommand,
    RollbackConfigCommand,
    ToggleFeatureFlagCommand,
    GetConfigQuery,
    GetFeatureFlagsQuery,

    // Fills the shared registry at boot, after every publish, and on its own timer.
    ConfigOverrideLoader,

    // Work 02 — verification management. No repository of its own: everything goes through the
    // port Module 01 exports.
    ListVerificationQueueQuery,
    GetVerificationQuery,
    ApproveVerificationCommand,
    RejectVerificationCommand,

    // Work 03 — user & account management, through the same port.
    ListUsersQuery,
    GetUserQuery,
    SuspendUserCommand,
    ReinstateUserCommand,

    // Work 04 — role assignment, through the same port. No RBAC logic of its own.
    ListRoleCatalogueQuery,
    GetUserRolesQuery,
    AssignRoleCommand,
    RevokeRoleCommand,

    // Work 05 — audit explorer, read-only, over the shared audit module's read port.
    ListAuditQuery,
    GetAuditEntryQuery,

    // Work 06 — COD dispute management, through Module 08's inbound port.
    ListCodDisputesQuery,
    GetCodDisputeQuery,
    ResolveCodDisputeCommand,

    // Work 07 — finance oversight, read-only, through Module 07's and Module 08's read ports.
    GetFinanceOverviewQuery,
    ListFinancePaymentsQuery,
    GetFinancePaymentQuery,
    ListFinanceRefundsQuery,

    // Work 08 — operational analytics, read-only, over six owner read ports.
    GetAnalyticsOverviewQuery,

    // Work 09 — catalogue review list, read-only, through Module 03's admin read port.
    ListCatalogReviewQuery,
  ],
  controllers: [
    AdminConfigController,
    AdminFeatureFlagController,
    AdminVerificationsController,
    AdminAccountsController,
    AdminRolesController,
    AdminAuditController,
    AdminCodDisputesController,
    AdminFinanceController,
    AdminAnalyticsController,
    AdminCatalogReviewController,
  ],
  // Nothing is exported. No other module calls into Admin — they read configuration through
  // `IConfigPort`, which is `SharedModule`'s, and an exported port here would be a coupling that
  // inverts the control-plane relationship.
})
export class AdminModule {}
