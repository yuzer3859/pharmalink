import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  DISPENSING_PORT,
  IDispensingPort,
} from '../../../prescription-matching/application/ports/inbound/dispensing.port';
import { OrdersErrors } from '../../domain/errors';
import { FulfillmentStatus } from '../../domain/enums';
import {
  FulfillmentSnapshot,
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepository,
} from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';
import { FulfillmentStatusPolicy } from '../../domain/services/fulfillment-status-policy';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { assertFulfillmentOrgScope } from '../support/assert-fulfillment-org-scope';
import { runWithOrderRetry } from '../support/order-retry';

export interface PrepareFulfillmentInput {
  fulfillmentId: string;
  actorUserId: string;
}

/**
 * `POST /pharmacy/orders/:fulfillmentId/prepare` (module-06 `06-orders-spec.md` §9.4, §3.6, §17,
 * BR-ORD-10). Org-scoped identically to `AcceptFulfillmentCommand` (Step 6). `Order.status`
 * is deliberately left unchanged (§3.4's "ACCEPTED | begins prep (fulfillment-level only) |
 * ACCEPTED (unchanged)" row) — only `Fulfillment.status` advances here.
 *
 * §3.11 invariant 4: a `Fulfillment` reaches `READY` only after `IDispensingPort.dispense()` has
 * succeeded for every Rx `OrderLine` on it — this command is where that dispensing happens (on
 * the `ACCEPTED -> PREPARING` transition, before `MarkReadyCommand`'s own `IInventoryPort.
 * dispatch()` calls). Dispensing is called once per Rx line, *before* this command's own local
 * transaction (Module 05's `DispenseMedicineCommand` owns its own `Serializable` transaction,
 * ADR-014's accepted eventual-consistency seam — mirrors every other cross-module port call in
 * this spec, e.g. `RematchCommand`'s `IInventoryPort.release()` calls). Each call's
 * `idempotencyKey` is derived from `(fulfillmentId, orderLineId)`, so a retried `/prepare` call
 * replays rather than double-dispenses (§6.3 of module-05's own spec).
 *
 * No outbox event is written here — §8's event catalog has no "fulfillment preparing" trigger for
 * Slice 1 (only `OrderAccepted`/`OrderReady`/`OrderCancelled`/`OrderPlaced`/`OrderPaid` are
 * cataloged); an audit entry alone records the transition.
 */
@Injectable()
export class PrepareFulfillmentCommand {
  constructor(
    @Inject(FULFILLMENT_REPOSITORY) private readonly fulfillments: IFulfillmentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
    @Inject(DISPENSING_PORT) private readonly dispensing: IDispensingPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: PrepareFulfillmentInput): Promise<FulfillmentSnapshot> {
    const fulfillment = await this.fulfillments.findById(input.fulfillmentId);
    if (!fulfillment) {
      throw OrdersErrors.notFound('Fulfillment not found.');
    }
    await assertFulfillmentOrgScope(
      this.identity,
      this.pharmacies,
      input.actorUserId,
      fulfillment.pharmacyId,
    );
    FulfillmentStatusPolicy.assertValidTransition(fulfillment.status, FulfillmentStatus.PREPARING);

    const lines = await this.orders.findLinesByOrderId(fulfillment.orderId);
    const rxLines = lines.filter(
      (line) => line.fulfillmentId === fulfillment.id && line.requiresRx && line.prescriptionLineId,
    );

    for (const line of rxLines) {
      await this.dispensing.dispense({
        prescriptionLineId: line.prescriptionLineId as string,
        idempotencyKey: `prepare:${fulfillment.id}:${line.id}`,
        orderId: fulfillment.orderId,
        pharmacyId: fulfillment.pharmacyId,
        quantity: line.quantity,
        dispensedByUserId: input.actorUserId,
      });
    }

    return runWithOrderRetry(this.uow, async (tx) => {
      const fresh = await this.fulfillments.findById(fulfillment.id, tx);
      if (!fresh) {
        throw OrdersErrors.notFound('Fulfillment not found.');
      }
      FulfillmentStatusPolicy.assertValidTransition(fresh.status, FulfillmentStatus.PREPARING);

      await this.fulfillments.updateStatus(fresh.id, { status: FulfillmentStatus.PREPARING }, tx);

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'FULFILLMENT_PREPARING',
          resourceType: 'Fulfillment',
          resourceId: fresh.id,
          context: { orderId: fresh.orderId, dispensedLineCount: rxLines.length },
        },
        tx,
      );

      return (await this.fulfillments.findById(fresh.id, tx)) as FulfillmentSnapshot;
    });
  }
}
