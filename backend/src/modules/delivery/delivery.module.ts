import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigService } from '../../shared/config/app-config.service';
import { AppLogger } from '../../shared/logging/app-logger.service';
import { RedisService } from '../../shared/redis/redis.service';
import { IdentityModule } from '../identity/identity.module';
import { AcceptJobOfferCommand } from './application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from './application/commands/advance-delivery-job.command';
import { CancelDeliveryJobCommand } from './application/commands/cancel-delivery-job.command';
import { CaptureProofOfDeliveryCommand } from './application/commands/capture-proof-of-delivery.command';
import { CreateDeliveryJobCommand } from './application/commands/create-delivery-job.command';
import { DeclineJobOfferCommand } from './application/commands/decline-job-offer.command';
import { DispatchDeliveryJobCommand } from './application/commands/dispatch-delivery-job.command';
import { PublishJobLocationCommand } from './application/commands/publish-job-location.command';
import { ReassignDeliveryJobCommand } from './application/commands/reassign-delivery-job.command';
import { CreateDriverProfileCommand } from './application/commands/create-driver-profile.command';
import { ManageDriverShiftCommand } from './application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from './application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from './application/commands/update-driver-location.command';
import { CATALOG_PORT } from './application/ports/outbound/catalog.port';
import { LOCATION_CACHE_PORT } from './application/ports/outbound/location-cache.port';
import { REALTIME_PORT } from './application/ports/outbound/realtime.port';
import { ETA_CACHE_PORT } from './application/ports/outbound/eta-cache.port';
import { ROUTING_PORT } from './application/ports/outbound/routing.port';
import { IDENTITY_PORT } from './application/ports/outbound/identity.port';
import { ORDERS_PORT } from './application/ports/outbound/orders.port';
import { PHARMACY_PORT } from './application/ports/outbound/pharmacy.port';
import { PROOF_ARTIFACT_STORAGE_PORT } from './application/ports/outbound/proof-artifact-storage.port';
import {
  COD_DISPUTE_ADMIN_PORT,
  CodDisputeAdminPortAdapter,
} from './application/ports/inbound/cod-dispute-admin.port';
import {
  COD_FINANCE_READ_PORT,
  CodFinanceReadPortAdapter,
} from './application/ports/inbound/cod-finance-read.port';
import { DELIVERY_ANALYTICS_READ_PORT } from './application/ports/inbound/delivery-analytics-read.port';
import { DELIVERY_PRICING_PORT } from './application/ports/inbound/delivery-pricing.port';
import { AccrueDriverEarningCommand } from './application/commands/accrue-driver-earning.command';
import { RecordCodCollectionCommand } from './application/commands/record-cod-collection.command';
import { RecordCodRemittanceCommand } from './application/commands/record-cod-remittance.command';
import { ReconcileCodCollectionCommand } from './application/commands/reconcile-cod-collection.command';
import { ListCodCollectionsQuery } from './application/queries/list-cod-collections.query';
import { RecordCodCorrectionCommand } from './application/commands/record-cod-correction.command';
import { ManageCodDisputeCommand } from './application/commands/manage-cod-dispute.command';
import { AdminCodCorrectionController } from './interface/controllers/admin-cod-correction.controller';
import { AdminCodReconciliationController } from './interface/controllers/admin-cod-reconciliation.controller';
import { GetCodCollectionQuery } from './application/queries/get-cod-collection.query';
import { COD_COLLECTION_REPOSITORY } from './domain/repositories/cod-collection.repository';
import { PrismaCodCollectionRepository } from './infrastructure/persistence/prisma-cod-collection.repository';
import { CodCollectionController } from './interface/controllers/cod-collection.controller';
import { GetDriverEarningsQuery } from './application/queries/get-driver-earnings.query';
import { DRIVER_EARNING_REPOSITORY } from './domain/repositories/driver-earning.repository';
import { PrismaDriverEarningRepository } from './infrastructure/persistence/prisma-driver-earning.repository';
import { DriverEarningsController } from './interface/controllers/driver-earnings.controller';
import { DeliveryCompletionHandler } from './interface/events/delivery-completion.handler';
import { ListDriverJobsQuery } from './application/queries/list-driver-jobs.query';
import { DriverJobsListController } from './interface/controllers/driver-jobs-list.controller';
import { DispatchRecoverySweeper } from './infrastructure/scheduling/dispatch-recovery.sweeper';
import { OfferExpirySweeper } from './infrastructure/scheduling/offer-expiry.sweeper';
import { StaleAssignmentSweeper } from './infrastructure/scheduling/stale-assignment.sweeper';
import { ADDRESS_PORT } from './application/ports/outbound/address.port';
import { QuoteDeliveryFeeQuery } from './application/queries/quote-delivery-fee.query';
import { AddressPortAdapter } from './infrastructure/address/address-port.adapter';
import { DeliveryQuoteController } from './interface/controllers/delivery-quote.controller';
import { UNIT_OF_WORK } from './application/ports/unit-of-work.port';
import { GetDeliveryJobStatusQuery } from './application/queries/get-delivery-job-status.query';
import { GetJobTrackingQuery } from './application/queries/get-job-tracking.query';
import { GetProofOfDeliveryQuery } from './application/queries/get-proof-of-delivery.query';
import { GetDriverOperationalStatusQuery } from './application/queries/get-driver-operational-status.query';
import { DeliveryAccessService } from './application/services/delivery-access.service';
import { DispatchCandidateService } from './application/services/dispatch-candidate.service';
import { EtaService } from './application/services/eta.service';
import { DELIVERY_JOB_REPOSITORY } from './domain/repositories/delivery-job.repository';
import { DRIVER_PROFILE_REPOSITORY } from './domain/repositories/driver-profile.repository';
import { JOB_OFFER_REPOSITORY } from './domain/repositories/job-offer.repository';
import { PROOF_OF_DELIVERY_REPOSITORY } from './domain/repositories/proof-of-delivery.repository';
import { CatalogPortAdapter } from './infrastructure/catalog/catalog-port.adapter';
import { IdentityPortAdapter } from './infrastructure/identity/identity-port.adapter';
import { OrdersPortAdapter } from './infrastructure/orders/orders-port.adapter';
import { PharmacyPortAdapter } from './infrastructure/pharmacy/pharmacy-port.adapter';
import { PrismaDeliveryJobRepository } from './infrastructure/persistence/prisma-delivery-job.repository';
import { PrismaDeliveryAnalyticsReadAdapter } from './infrastructure/persistence/prisma-delivery-analytics-read.adapter';
import { PrismaDriverProfileRepository } from './infrastructure/persistence/prisma-driver-profile.repository';
import { PrismaJobOfferRepository } from './infrastructure/persistence/prisma-job-offer.repository';
import { PrismaProofOfDeliveryRepository } from './infrastructure/persistence/prisma-proof-of-delivery.repository';
import { PrismaUnitOfWork } from './infrastructure/persistence/prisma-unit-of-work';
import {
  InMemoryLocationCache,
  RedisLocationCache,
} from './infrastructure/realtime/redis-location-cache';
import {
  InMemoryRealtimeAdapter,
  RedisRealtimeAdapter,
} from './infrastructure/realtime/redis-realtime.adapter';
import { InMemoryEtaCache, RedisEtaCache } from './infrastructure/routing/eta-cache';
import { HaversineRoutingAdapter } from './infrastructure/routing/haversine-routing.adapter';
import { InMemoryProofArtifactStorage } from './infrastructure/storage/in-memory-proof-artifact.storage';
import { DriverJobController } from './interface/controllers/driver-job.controller';
import { ProofOfDeliveryController } from './interface/controllers/proof-of-delivery.controller';
import { TrackingController } from './interface/controllers/tracking.controller';
import { JobCreatedHandler } from './interface/events/job-created.handler';
import { OrderCancelledHandler } from './interface/events/order-cancelled.handler';
import { OrderReadyHandler } from './interface/events/order-ready.handler';
import { TrackingGateway } from './interface/ws/tracking.gateway';
import { WsAuthService } from './interface/ws/ws-auth.service';

/**
 * Delivery Management & Tracking composition root (§10).
 *
 * The domain-foundation work deliberately built no module — it stopped at the repository port,
 * exactly as Modules 06 and 07 stopped at theirs. This, the job-creation work, is the first with
 * something to wire: `CreateDeliveryJobCommand`, its three cross-module read adapters, the Prisma
 * repository and the `order.ready` handler that drives it.
 *
 * The driver-operational-profile work adds the second: the `DriverProfile` aggregate, its Prisma
 * repository, the four commands that move a driver's operational state, the status query that
 * carries the concurrent-job capacity dispatch will consume, and an `IIdentityPort` that answers
 * BRULE-09 from Module 01's own tables rather than from a mirrored flag.
 *
 * The dispatch work adds the third: candidate selection and ranking, `JobOffer` with its TTL, the
 * accept/decline/reassign commands, and the `delivery.job.created` handler that starts the whole
 * thing (§11.1's "CreateDeliveryJob → DispatchJob").
 *
 * **The first controller in the module**, and only because a permission finally fits one.
 * `delivery:accept:own` and `delivery:update:own` have been in the RBAC catalogue since Phase 0,
 * granted to `DRIVER` and attached to nothing; §9.2's accept and decline routes are what they were
 * seeded for, and this is the first work with a workflow behind them. Everything else §9 lists
 * still has no route: §9.1's driver-profile routes have no permission that describes availability,
 * §9.3's internal dispatch is served by the event handler, and §9.5's admin reassign would need a
 * platform-scoped delivery permission the catalogue does not have. Inventing an RBAC grant ahead
 * of the surface it guards remains the wrong order.
 *
 * **Nothing is exported.** No other module calls into Delivery today: Module 06 reaches it through
 * `order.ready` and will learn of progress through `JobCreated` and its successors. An exported
 * port would be a coupling nobody has asked for.
 *
 * `AuditService`, `OutboxService`, `EventBusService`, `AppLogger` and `PrismaService` all come from
 * the `@Global()` `SharedModule`, and `JwtAuthGuard`/`PermissionsGuard` are already global from
 * `IdentityModule`, so none is re-provided here — the same shape every other feature module has.
 *
 * The status work adds the fourth: the driver-facing lifecycle (arrived, picked up, en route,
 * arrived, delivered, failed), its six routes, cancellation from Module 06's `order.cancelled`,
 * and the four catalogued events that let Orders follow along.
 *
 * The tracking work adds the fifth, and the module's first non-HTTP surface: `TrackingGateway` on
 * the `/tracking` namespace, the Redis pub/sub fan-out behind `IRealtimePort`, the hot last-known
 * cache behind `ILocationCachePort`, and one authorized read — `GetJobTrackingQuery` — shared by
 * the socket's subscribe handler and the REST fallback so the two cannot disagree about who may
 * watch a delivery. It also brings the **first customer-facing route in Module 08**; every earlier
 * one was a driver's. `order:read:own` covers it, and has since Phase 0.
 *
 * The ETA work adds the sixth: `IRoutingPort` — the boundary that keeps every routing vendor out
 * of this module — a deterministic adapter behind it, a destination-scoped route cache, and one
 * `EtaService` that the fan-out and the snapshot share. No surface is added: the estimate rides on
 * the tracking payload both of them already produced.
 *
 * The readiness work adds the last: the three background recovery workers, `GET /driver/jobs`, and
 * a COD summary over the finance filters that already existed. It closes §6.5's and §11.5's
 * deferrals — `OfferExpirySweeper` retires offers whose TTL has passed, `DispatchRecoverySweeper`
 * keeps asking for a driver for a job that had none and rescues one left mid-reassignment by a
 * stopped process, and `StaleAssignmentSweeper` takes a pre-pickup job back from a driver who has
 * stopped working. None of them adds a state, a rule or an event: each one re-runs a command that
 * already existed, which is why none of them can decide anything the state machine does not.
 *
 * Deliberately absent, and now genuinely the end of Module 08's scope: a real routing provider
 * (there is no approved contract for one), the safe driver summary a customer eventually sees
 * beside the map (Module 01 exports no such contract — re-checked in this work, see
 * `TrackingResponse`), `location_snapshots` for historical trails, the failed-delivery
 * return/refund policy (Module 06 and 07 decide it; this module only emits `DeliveryFailed`), the
 * admin delivery-monitoring and manual-reassign routes §9.5 names — still without a
 * platform-scoped delivery permission in the catalogue — and the Module 07 half of COD settlement:
 * a `COD_CLEARING` posting, a pharmacy payable, a payout. That last one needs a financial contract
 * that does not exist yet, and Work 14 confirmed it still does not: nothing outside this module
 * consumes any `delivery.*` event.
 */
@Module({
  // Module 01's two authentication contracts, for the tracking gateway's handshake. A WebSocket
  // carries its token outside the request pipeline, so it reaches no guard and must run the same
  // checks itself — see `WsAuthService`. This is the module's only import; everything else it uses
  // comes from the `@Global()` `SharedModule`.
  // `ScheduleModule.forRoot()` activates the `@Cron` decorators on the three recovery workers
  // below. Registered here rather than relied upon from another module's registration: a feature
  // that silently stops working because an unrelated module dropped an import is not a dependency
  // anybody would think to check.
  imports: [IdentityModule, ScheduleModule.forRoot()],
  providers: [
    { provide: DELIVERY_JOB_REPOSITORY, useClass: PrismaDeliveryJobRepository },
    { provide: DRIVER_PROFILE_REPOSITORY, useClass: PrismaDriverProfileRepository },
    { provide: JOB_OFFER_REPOSITORY, useClass: PrismaJobOfferRepository },
    { provide: PROOF_OF_DELIVERY_REPOSITORY, useClass: PrismaProofOfDeliveryRepository },
    { provide: DRIVER_EARNING_REPOSITORY, useClass: PrismaDriverEarningRepository },
    { provide: COD_COLLECTION_REPOSITORY, useClass: PrismaCodCollectionRepository },
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },

    // Background operational recovery (§6.5, §11.5). Each is safe to run on every application
    // instance simultaneously — see the class comments for how claiming and convergence work — so
    // none of them needs a leader election or a "run on one node only" deployment note.
    OfferExpirySweeper,
    DispatchRecoverySweeper,
    StaleAssignmentSweeper,

    // Cross-module outbound read ports (own copy per ADR-002). Module 08 reads Module 06 for the
    // fulfillment and its frozen order snapshot, Module 04 for the pickup branch, and Module 03
    // for BRULE-30's cold-chain flag — each a direct same-database read, never a Prisma relation.
    { provide: ORDERS_PORT, useClass: OrdersPortAdapter },
    { provide: PHARMACY_PORT, useClass: PharmacyPortAdapter },
    // Module 02, for the *pre-order* destination a delivery quote is priced against. The job
    // lifecycle never uses it: once an order exists, the address it was placed against is frozen
    // on `Order.addressSnapshot` and comes back through `ORDERS_PORT` instead.
    { provide: ADDRESS_PORT, useClass: AddressPortAdapter },
    { provide: CATALOG_PORT, useClass: CatalogPortAdapter },
    // Module 01, for BRULE-09. Read live at the moment a driver goes online — never cached, and
    // never mirrored into `driver_profiles`: a stale copy of an authorization fact fails open.
    { provide: IDENTITY_PORT, useClass: IdentityPortAdapter },

    CreateDeliveryJobCommand,
    OrderReadyHandler,

    // Dispatch (§6, §11.1/§11.2/§11.5). `JobCreatedHandler` is the only automatic trigger;
    // declines and reassignments re-dispatch themselves, and an expired offer is retired by
    // whichever dispatch pass next looks at the job.
    DispatchCandidateService,
    DispatchDeliveryJobCommand,
    AcceptJobOfferCommand,
    DeclineJobOfferCommand,
    ReassignDeliveryJobCommand,
    JobCreatedHandler,

    // The status workflow (§3.3 F-STS-01/03, §11.4). `AdvanceDeliveryJobCommand` carries every
    // transition; `CancelDeliveryJobCommand` is the pre-pickup cancellation Module 06's
    // `order.cancelled` drives, and refuses once a driver is carrying the goods.
    AdvanceDeliveryJobCommand,
    CancelDeliveryJobCommand,
    GetDeliveryJobStatusQuery,
    OrderCancelledHandler,

    CreateDriverProfileCommand,
    SetDriverAvailabilityCommand,
    ManageDriverShiftCommand,
    UpdateDriverLocationCommand,
    GetDriverOperationalStatusQuery,
    ListDriverJobsQuery,

    // Real-time tracking (§3.4 F-TRK-01/03, §7). Both transports are chosen at boot from whether
    // `REDIS_URL` is configured, because Redis is optional by design: without it the platform is
    // a correct single node, and with it the same code fans out across every node. Selecting here
    // rather than branching inside one class keeps each implementation honest about what it is —
    // neither pretends to a guarantee it cannot make.
    {
      provide: LOCATION_CACHE_PORT,
      inject: [RedisService, AppConfigService],
      useFactory: (redis: RedisService, config: AppConfigService) =>
        redis.isEnabled ? new RedisLocationCache(redis, config) : new InMemoryLocationCache(config),
    },
    {
      provide: REALTIME_PORT,
      inject: [RedisService, AppLogger],
      useFactory: (redis: RedisService, logger: AppLogger) =>
        redis.isEnabled ? new RedisRealtimeAdapter(redis, logger) : new InMemoryRealtimeAdapter(),
    },
    PublishJobLocationCommand,
    GetJobTrackingQuery,
    WsAuthService,
    TrackingGateway,

    // The one authorization decision behind every customer-facing delivery read — the tracking
    // snapshot, the ETA riding on it, and the proof-of-delivery read. One service rather than a
    // check copied into each, because copies drift and a drifted copy here shows somebody another
    // household's delivery.
    DeliveryAccessService,

    // ETA and route calculation (§3.4 F-TRK-02, §7). `EtaService` is the module's only arrival
    // estimate — the live fan-out and the snapshot read both call it, so a customer's map and
    // their refresh can never disagree about when their medicines arrive.
    //
    // `ROUTING_PORT` is bound to the deterministic adapter because no routing provider is
    // configured in this repository, exactly as Module 07 binds `MockPaymentProvider` with no
    // gateway credentials. Pointing it at a real vendor is a one-line change here and touches
    // nothing else, which is the whole reason the port exists.
    { provide: ROUTING_PORT, useClass: HaversineRoutingAdapter },
    {
      provide: ETA_CACHE_PORT,
      inject: [RedisService, AppConfigService],
      useFactory: (redis: RedisService, config: AppConfigService) =>
        redis.isEnabled ? new RedisEtaCache(redis, config) : new InMemoryEtaCache(config),
    },
    EtaService,

    // Proof of delivery (§3.3 F-STS-04, §5.2, BR-DEL-06, BRULE-29). The capture command, the
    // authorized read, the `proof_of_delivery` repository, and the artifact storage seam.
    //
    // `PROOF_ARTIFACT_STORAGE_PORT` is bound to the in-process adapter because the platform has
    // **no approved object-storage provider** — the same position Module 01's verification
    // documents have been in since Phase 0, and the same reason `ROUTING_PORT` above points at a
    // deterministic adapter rather than a map vendor. Choosing one is a procurement and security
    // decision about credentials, encryption at rest, retention and data residency, and adding S3
    // or Cloudinary to satisfy a task would commit the platform to a vendor by side effect.
    //
    // This is safe as shipped precisely because every `delivery.pod*Requirement` defaults to
    // `NONE`: nothing on the platform demands a stored artifact, so nothing depends on an adapter
    // that cannot survive a restart. Raising a requirement to `ARTIFACT` and binding a real
    // provider are the same decision, and the wiring makes that explicit rather than incidental.
    { provide: PROOF_ARTIFACT_STORAGE_PORT, useClass: InMemoryProofArtifactStorage },
    CaptureProofOfDeliveryCommand,
    GetProofOfDeliveryQuery,

    // Delivery fee and quoting (§3.5 F-FEE-01, BR-DEL-09, §9.2's `GET /delivery/quote`).
    //
    // `QuoteDeliveryFeeQuery` is the platform's only delivery-fee calculation, and it is bound to
    // `DELIVERY_PRICING_PORT` with `useExisting` rather than `useClass` deliberately: one instance
    // answers the HTTP route and Module 06's two checkout call sites, so a customer's quote and
    // their charge cannot be computed by two objects that have drifted apart.
    //
    // The rate card itself is empty by default — every `delivery.fee*` key is zero and no zones are
    // configured — which is why introducing this changes no existing total. See
    // `delivery.config.ts` for why a delivery module does not ship with prices nobody approved.
    QuoteDeliveryFeeQuery,
    { provide: DELIVERY_PRICING_PORT, useExisting: QuoteDeliveryFeeQuery },
    // Module 16's control-plane view of COD disputes (ADR-002 inbound port). A facade over
    // `ManageCodDisputeCommand` and the finance read; nothing decides outside the aggregate.
    { provide: COD_DISPUTE_ADMIN_PORT, useClass: CodDisputeAdminPortAdapter },
    { provide: COD_FINANCE_READ_PORT, useClass: CodFinanceReadPortAdapter },
    // Inbound read contract for Module 16's operational dashboard (module-16 Work 08): job and
    // driver counts, aggregated in PostgreSQL. No job, no driver, no cash crosses it.
    { provide: DELIVERY_ANALYTICS_READ_PORT, useClass: PrismaDeliveryAnalyticsReadAdapter },

    // Driver earnings (§3.5 F-ERN-01/F-ERN-02, BR-DEL-10, §6's
    // `CompleteDelivery → AccrueEarning → DriverEarning(ACCRUED)`).
    //
    // `DeliveryCompletionHandler` is what finally makes `COMPLETED` reachable: the status work
    // built the transition and deliberately left nothing driving it, because `COMPLETED` means the
    // platform has squared its books and there were no books to square. Now there are.
    //
    // **Nothing here moves money.** No ledger entry, no wallet, no settlement, no payout, no
    // provider — §1 gives all of that to Module 07, which learns what it owes from the
    // `EarningAccrued` event written in the same transaction as the earning row. There is
    // deliberately no port into Module 07 either: Module 07 has no driver-payable account and no
    // earnings contract to align with, and a port with no implementer would be a guess about one.
    //
    // The earning agreement itself is empty by default — every `delivery.earning*` key is zero —
    // because the design's Open Question 4 ("who funds it: platform vs delivery fee split?") is
    // unresolved. See `delivery.config.ts` for what remains a product decision and why a non-zero
    // default would be the platform quietly committing to pay an amount nobody agreed.
    AccrueDriverEarningCommand,
    GetDriverEarningsQuery,
    DeliveryCompletionHandler,

    // Cash on delivery (§3.5 F-COD-01, BR-DEL-10, §6's
    // `CompleteDelivery → if COD → RecordCod → CodCollection`).
    //
    // The driver is a **collection channel**, not the owner of the customer's money: the approved
    // flow is customer → driver → PharmaLink → pharmacy, and a `cod_collections` row records the
    // first two legs only. Nothing here moves money — no ledger entry, no `Payment` marked
    // captured, no wallet, no settlement, no payout — and there is deliberately no port into
    // Module 07 either: `COD_CLEARING` exists in its ledger enum but nothing writes it, so there is
    // no contract to consume and a port would be a guess about one. Module 07 learns what it needs
    // from the `CodCollected` event written in the same transaction as the row.
    RecordCodCollectionCommand,
    GetCodCollectionQuery,

    // COD remittance and reconciliation (§3.5 F-COD-01, §9.5's
    // `/admin/delivery/cod-reconciliation`) — the second and third legs of
    // customer → driver → **PharmaLink** → pharmacy.
    //
    // The COD work above shipped no way to reach `REMITTED` or `RECONCILED` and said why: both are
    // assertions that money reached and was verified by PharmaLink, and the only actor with a route
    // near that aggregate was the driver holding the cash. It promised that the work implementing
    // the cadence would add the transitions **together with the authority allowed to call them**.
    // That pairing is what these three providers are: `finance:settlement:any` to assert either
    // step, `finance:report:any` to read — both existing catalogue keys, neither held by any driver
    // role, and no new permission invented.
    //
    // The lifecycle is enforced, not documented: `COLLECTED → RECONCILED` is unreachable because
    // the policy names `REMITTED`, the repository compare-and-sets on `REMITTED`, and a
    // reconciliation row cannot be written without a remittance row to point at.
    //
    // **Still nothing here moves money.** No ledger entry, no `COD_CLEARING` transaction, no driver
    // payable, no pharmacy payable, no settlement, no payout, no wallet, no provider call — and
    // deliberately still no port into Module 07, which has no COD consumer contract to align with.
    // Module 07 learns what it needs from `CodRemitted` and `CodReconciled`, written in the same
    // transactions as the rows they describe.
    //
    // And still no driver balance. What a driver is *owed* (`driver_earnings`) and what a driver is
    // *holding* (`cod_collections`) are unrelated amounts; nothing in this module nets one against
    // the other, and the finance read deliberately never joins the two tables.
    RecordCodRemittanceCommand,
    ReconcileCodCollectionCommand,
    ListCodCollectionsQuery,

    // COD corrections and disputes (§3.5 F-COD-01, the design's Open Question 5).
    //
    // The three COD records above are append-only on purpose — evidence that can be edited is not
    // evidence — and each of those works said the same thing about the gap that leaves: a
    // correction is a new auditable adjustment under a workflow deciding who may restate a fact.
    // These two commands are that workflow, and they take the shape the project already has for a
    // fact that cannot be undone, Module 07's `refunds` against a payment it cannot un-charge.
    //
    // **Nothing here edits history.** No amount, method, reference, timestamp or status on
    // `cod_collections`, `cod_remittances` or `cod_reconciliations` is written by either command,
    // and the repository offers no method that could. A correction is a row beside the record; a
    // dispute is a question beside it.
    //
    // **And no discrepancy disappears.** Every variance the finance view reports is still computed
    // from the original rows, with corrections listed alongside — `original fact + correction` is
    // the history rather than a replacement for it.
    //
    // Still no money movement: no ledger entry, no payable, no settlement, no payout, no driver
    // balance. And no correction type or dispute outcome that decides **who absorbs a shortfall** —
    // there is no `WRITE_OFF`, no `RECOVERY`, no `DRIVER_LIABLE` anywhere in either vocabulary,
    // because that commercial decision has not been taken and an enum value is how it would get
    // taken by accident.
    //
    // One event, `CodCorrectionRecorded`, because a restated amount is something a future Module 07
    // posting genuinely needs to learn about. **No dispute event**: nothing outside this module acts
    // on a dispute, and emitting one would be adding an event because a record exists.
    RecordCodCorrectionCommand,
    ManageCodDisputeCommand,
  ],
  controllers: [
    AdminCodCorrectionController,
    AdminCodReconciliationController,
    CodCollectionController,
    DeliveryQuoteController,
    DriverEarningsController,
    DriverJobController,
    DriverJobsListController,
    ProofOfDeliveryController,
    TrackingController,
  ],
  // Module 06 imports this module and injects `IDeliveryPricingPort` directly — in-process DI, no
  // HTTP round-trip to ourselves, the same seam `PrescriptionMatchingModule` exports for matching
  // and the Rx gate. Nothing else is exported: the delivery fee is the one capability another
  // module has any business calling, and a module that exported its repositories would invite
  // exactly the cross-context reach ADR-002 forbids.
  //
  // There is no import cycle. This module reads Module 06 through its own `OrdersPortAdapter` —
  // a direct database read, never an `OrdersModule` import — so the dependency runs one way.
  exports: [
    DELIVERY_PRICING_PORT,
    COD_DISPUTE_ADMIN_PORT,
    COD_FINANCE_READ_PORT,
    DELIVERY_ANALYTICS_READ_PORT,
  ],
})
export class DeliveryModule {}
