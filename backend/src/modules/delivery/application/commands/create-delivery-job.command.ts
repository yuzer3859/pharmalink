import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService, OutboxCapableClient } from '../../../../shared/outbox/outbox.service';
import {
  DeliveryItemSummary,
  DeliveryJob,
  DeliveryJobProps,
} from '../../domain/entities/delivery-job.entity';
import { jobCreatedEvent } from '../../domain/events';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import { GeoPoint } from '../../domain/value-objects/geo-point.vo';
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';
import {
  DeliverableFulfillmentView,
  IOrdersPort,
  ORDERS_PORT,
} from '../ports/outbound/orders.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';
import { IRoutingPort, ROUTING_PORT } from '../ports/outbound/routing.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { isUniqueConstraintViolation, runWithDeliveryRetry } from '../support/delivery-retry';

export interface CreateDeliveryJobInput {
  /** The job's natural key. Everything else is resolved from it. */
  fulfillmentId: string;
  /** Who or what triggered creation, for the audit trail. `null` for the `order.ready` handler. */
  actorUserId?: string | null;
}

export interface CreateDeliveryJobResult {
  job: DeliveryJobProps;
  /** `true` when an existing job was returned rather than a new one created. */
  replay: boolean;
}

/**
 * `CreateDeliveryJob` (§3.2 F-JOB-01, BR-DEL-01, BRULE-27) — turns a ready fulfillment into a
 * delivery job.
 *
 * ## The input is one id, deliberately
 *
 * Not a pickup address, not an item list, not a COD amount. Every fact on the job is resolved
 * from its owning module at creation time, because this command's caller is an event handler
 * carrying `{ orderId, fulfillmentId }` and nothing else — and because a caller that could supply
 * a COD amount could supply the wrong one. The one thing a caller may not override is what the
 * driver will be told to collect.
 *
 * ## Snapshots, and which source is authoritative
 *
 * The job freezes what it needs (§5.3): a later address edit, branch move or product rename must
 * not retroactively change a delivery that already happened.
 *
 *  - **Dropoff** comes from `Order.addressSnapshot` via `IOrdersPort` — the address the order was
 *    *placed against*, not the customer's current one. Module 06 already froze it at checkout, and
 *    `orders` stores no `addressId`, so a live Module 02 read is both wrong and impossible.
 *  - **Pickup** comes from Module 04's branch, live, because there is no earlier snapshot of it
 *    and the driver has to go where the branch is now.
 *  - **Items** come from the order lines' own `productSnapshot` names, so the driver sees what the
 *    customer ordered.
 *  - **Cold chain** comes from Module 03 (BRULE-30) — `productSnapshot` records only a name, so
 *    storage requirements are not in Module 06's copy at all.
 *  - **The delivery fee** comes from `Order.deliveryFee` — **read, never recalculated** (F-FEE-01,
 *    BR-DEL-09). Module 06 froze the charge inside its checkout transaction and the customer has
 *    already agreed to it; re-running the rate card here would produce a second money fact for the
 *    same delivery, and the two would part company the first time an operator adjusted a rate
 *    between checkout and dispatch. This module *calculated* that number, through
 *    `IDeliveryPricingPort`, and stopped owning it the moment it became a line on an order.
 *  - **The distance** comes from `IRoutingPort`, live, and is Delivery's own operational fact
 *    rather than a money one: it is what the job was dispatched against. A provider that cannot
 *    answer yields `null` and the job is still created, because a delivery must not fail to exist
 *    because a map service is down — the same stance `EtaService` takes on a missing estimate.
 *
 * ## Idempotency
 *
 * `fulfillmentId` is the natural key, backed by a unique index — the same
 * deterministic-natural-key discipline Modules 06 and 07 use everywhere. A redelivered
 * `order.ready` event (the outbox is at-least-once by design, ADR-010) replays the committed job
 * rather than cutting a second one, which would put two drivers on the road to the same pharmacy
 * for the same medicines.
 *
 * Checked twice — cheaply before the transaction, and again inside it — with the unique-index
 * violation caught and resolved by returning the winner, exactly as `RunSettlementCommand` and
 * `ApplyCouponCommand` resolve their own races.
 *
 * ## What it does not do
 *
 * It does not dispatch. The job is created in `CREATED`; finding a driver, offering, and the
 * concurrent-job limit are the dispatch work. It also does not advance the order — §1 gives order
 * state to Module 06, which consumes `JobCreated`.
 */
@Injectable()
export class CreateDeliveryJobCommand {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(ORDERS_PORT) private readonly orders: IOrdersPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
    @Inject(ROUTING_PORT) private readonly routing: IRoutingPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: CreateDeliveryJobInput): Promise<CreateDeliveryJobResult> {
    const fulfillmentId = requireText(input.fulfillmentId, 'fulfillmentId');

    // Cheap replay: a redelivered event does no cross-module reading at all.
    const existing = await this.jobs.findByFulfillmentId(fulfillmentId);
    if (existing) {
      return { job: existing, replay: true };
    }

    const fulfillment = await this.orders.getDeliverableFulfillment(fulfillmentId);
    if (!fulfillment) {
      throw DeliveryErrors.fulfillmentNotDeliverable(fulfillmentId, null);
    }
    // BRULE-27. Module 06 decides what "ready" means; this command only refuses.
    if (!fulfillment.isReadyForDelivery) {
      throw DeliveryErrors.fulfillmentNotDeliverable(fulfillmentId, fulfillment.status);
    }

    const job = await this.buildJob(fulfillment);

    try {
      return await runWithDeliveryRetry(this.uow, async (tx) => {
        const raced = await this.jobs.findByFulfillmentId(fulfillmentId, tx);
        if (raced) {
          return { job: raced, replay: true };
        }

        const written = await this.jobs.create(job, tx);

        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? null,
            action: 'DELIVERY_JOB_CREATED',
            resourceType: 'DeliveryJob',
            resourceId: written.id,
            context: {
              orderId: written.orderId,
              fulfillmentId: written.fulfillmentId,
              pharmacyId: written.pharmacyId,
              branchId: written.branchId,
              isColdChain: written.isColdChain,
              isCod: written.isCod,
              // The amount, because §13 requires the trail to identify what a driver was told to
              // collect — the figure a COD dispute is argued over.
              codAmount: written.codAmount,
              // The delivery-fee snapshot and the route it was dispatched against, so the trail can
              // explain a completed delivery without re-deriving either from today's configuration.
              deliveryFee: written.deliveryFee,
              distanceMeters: written.distanceMeters,
              itemCount: written.items.length,
            },
          },
          tx,
        );

        await this.outbox.write(
          jobCreatedEvent({
            jobId: written.id,
            orderId: written.orderId,
            fulfillmentId: written.fulfillmentId,
            pharmacyId: written.pharmacyId,
            branchId: written.branchId,
            isColdChain: written.isColdChain,
            isCod: written.isCod,
          }),
          tx as OutboxCapableClient,
        );

        return { job: written, replay: false };
      });
    } catch (err) {
      // Two creators raced the unique index. The loser returns the winner's job rather than
      // reporting a conflict an event handler would only retry into again.
      if (isUniqueConstraintViolation(err)) {
        const winner = await this.jobs.findByFulfillmentId(fulfillmentId);
        if (winner) {
          return { job: winner, replay: true };
        }
      }
      throw err;
    }
  }

  /**
   * Resolves every snapshot and builds the aggregate.
   *
   * Done **outside** the transaction: these are three cross-module reads, and ADR-014's discipline
   * — each port call opens its own transaction — means holding a `Serializable` transaction across
   * them would be both a correctness and an availability defect. Nothing read here is a side
   * effect, so a serialization retry re-reading it is harmless.
   */
  private async buildJob(fulfillment: DeliverableFulfillmentView): Promise<DeliveryJobProps> {
    const branch = await this.pharmacies.getBranchPickup(fulfillment.branchId);
    const pickupPoint = GeoPoint.optional(branch?.lat, branch?.lng);
    const dropoffPoint = GeoPoint.optional(fulfillment.dropoff?.lat, fulfillment.dropoff?.lng);

    const items: DeliveryItemSummary[] = fulfillment.lines.map((line) => ({
      catalogProductId: line.catalogProductId,
      name: line.name,
      quantity: line.quantity,
    }));

    // BRULE-30: one cold-chain product makes the whole job cold-chain, because the job routes
    // through a single temperature regime — there is no partly-refrigerated bag.
    const productIds = [...new Set(items.map((item) => item.catalogProductId))];
    const coldChainIds =
      productIds.length > 0 ? await this.catalog.findColdChainProductIds(productIds) : [];

    return DeliveryJob.create({
      id: randomUUID(),
      orderId: fulfillment.orderId,
      fulfillmentId: fulfillment.fulfillmentId,
      pharmacyId: fulfillment.pharmacyId,
      branchId: fulfillment.branchId,
      pickupPoint,
      pickupAddress: branch?.addressLine ?? null,
      dropoffPoint,
      dropoffAddress: composeDropoffLine(fulfillment.dropoff),
      items,
      isColdChain: coldChainIds.length > 0,
      // The charged amount, copied. Not `DeliveryFeePolicy` run again — see the snapshots note.
      deliveryFee: fulfillment.deliveryFee,
      distanceMeters: await this.routeDistance(pickupPoint, dropoffPoint),
      isCod: fulfillment.isCod,
      // The whole order total, not a per-fulfillment share. Slice 1 is single-fulfillment, and
      // splitting a COD collection across drivers is a product decision nobody has made — see the
      // deferred note in the module doc. A wrong split would have a driver collect the wrong cash.
      codAmount: fulfillment.isCod ? fulfillment.orderTotal : null,
    }).toProps();
  }

  /**
   * The road distance this job was dispatched against, or `null`.
   *
   * **Never fails the creation.** A missing coordinate means the provider is not even asked; a
   * provider that answers `null`, or throws despite `IRoutingPort`'s contract saying it should not,
   * leaves the distance unrecorded. In every case the job is still cut, because the alternative is
   * a customer's paid-for medicines sitting at a pharmacy with no delivery job because a map
   * service was unreachable. `null` here is the honest "we do not know", and nothing prices from
   * it: the fee was frozen by Module 06 long before this point.
   */
  private async routeDistance(
    pickup: GeoPoint | null,
    dropoff: GeoPoint | null,
  ): Promise<number | null> {
    if (pickup === null || dropoff === null) {
      return null;
    }
    try {
      const route = await this.routing.route({ origin: pickup, destination: dropoff });
      return route === null ? null : Math.round(route.distanceMeters);
    } catch {
      return null;
    }
  }
}

function composeDropoffLine(
  dropoff: DeliverableFulfillmentView['dropoff'],
): string | null {
  if (!dropoff) {
    return null;
  }
  const parts = [dropoff.line1, dropoff.city].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(', ') : null;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
