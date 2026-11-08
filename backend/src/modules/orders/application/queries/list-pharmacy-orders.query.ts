import { Inject, Injectable } from '@nestjs/common';
import { OrdersErrors } from '../../domain/errors';
import { FulfillmentStatus } from '../../domain/enums';
import { PagedResult } from '../../domain/repositories/order.repository';
import {
  IPharmacyOrderViewReadPort,
  PHARMACY_ORDER_VIEW_READ_PORT,
  PharmacyOrderView,
} from '../ports/inbound/pharmacy-order-view-read.port';
import { IDENTITY_PORT, IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';

export interface ListPharmacyOrdersInput {
  actorUserId: string;
  status?: FulfillmentStatus;
  page: number;
  size: number;
}

/**
 * `GET /pharmacy/orders` (module-06 §9.4): the fulfilments of the actor's pharmacies.
 *
 * Work 107: each item is the fulfilment as before (every earlier field unchanged), plus its order's
 * header and the lines it carries, so the pharmacy portal can prepare an order from the list.
 */
@Injectable()
export class ListPharmacyOrdersQuery {
  constructor(
    @Inject(PHARMACY_ORDER_VIEW_READ_PORT) private readonly views: IPharmacyOrderViewReadPort,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
  ) {}

  async execute(input: ListPharmacyOrdersInput): Promise<PagedResult<PharmacyOrderView>> {
    const pharmacyIds = await actorPharmacyIds(this.identity, this.pharmacies, input.actorUserId);
    if (pharmacyIds.length === 0) return { items: [], total: 0 };
    return this.views.list({ pharmacyIds, status: input.status, page: input.page, size: input.size });
  }
}

/**
 * Work 107: `GET /pharmacy/orders/:fulfillmentId`, one fulfilment of the actor's pharmacies. Another
 * pharmacy's fulfilment, or one not yet visible (an unpaid prepaid order), reads as not found.
 */
@Injectable()
export class GetPharmacyOrderQuery {
  constructor(
    @Inject(PHARMACY_ORDER_VIEW_READ_PORT) private readonly views: IPharmacyOrderViewReadPort,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
  ) {}

  async execute(input: { actorUserId: string; fulfillmentId: string }): Promise<PharmacyOrderView> {
    const pharmacyIds = await actorPharmacyIds(this.identity, this.pharmacies, input.actorUserId);
    const view = pharmacyIds.length === 0 ? null : await this.views.findById(input.fulfillmentId, pharmacyIds);
    if (!view) throw OrdersErrors.notFound('Fulfillment not found.');
    return view;
  }
}

async function actorPharmacyIds(identity: IIdentityPort, pharmacies: IPharmacyPort, userId: string): Promise<string[]> {
  const organizationIds = await identity.getUserOrganizationIds(userId);
  if (organizationIds.length === 0) return [];
  return pharmacies.findPharmacyIdsByOrganizationIds(organizationIds);
}
