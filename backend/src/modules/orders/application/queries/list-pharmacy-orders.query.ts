import { Inject, Injectable } from '@nestjs/common';
import { FulfillmentStatus } from '../../domain/enums';
import {
  FULFILLMENT_REPOSITORY,
  FulfillmentSnapshot,
  IFulfillmentRepository,
} from '../../domain/repositories/fulfillment.repository';
import { PagedResult } from '../../domain/repositories/order.repository';
import { IDENTITY_PORT, IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';

export interface ListPharmacyOrdersInput {
  actorUserId: string;
  status?: FulfillmentStatus;
  page: number;
  size: number;
}

/**
 * `GET /pharmacy/orders` (module-06 `06-orders-spec.md` §9.4) — the fulfillments belonging to the
 * caller's own pharmacies, paginated and optionally status-filtered.
 *
 * Scope is resolved entirely server-side from the authenticated `actorUserId`, in the same two
 * hops `assertFulfillmentOrgScope` uses, only in reverse:
 *  1. `IIdentityPort.getUserOrganizationIds()` -> the caller's **`Organization.id`**s (what
 *     `user_roles.organizationId` stores).
 *  2. `IPharmacyPort.findPharmacyIdsByOrganizationIds()` -> the **`Pharmacy.id`**s those
 *     organizations own, which is what `Fulfillment.pharmacyId` and therefore
 *     `IFulfillmentRepository.listByPharmacyIds()` are keyed by.
 *
 * Passing organization ids straight into `listByPharmacyIds` — as an earlier draft did — silently
 * returns nothing, since the two id spaces never overlap. The repository deliberately does not
 * resolve scope itself (§9.4's `ListFulfillmentsByPharmacyCriteria` doc) and the controller must
 * not either, so this query is the seam that joins them.
 *
 * A caller who belongs to no organization, or whose organizations own no pharmacy, gets an empty
 * page rather than an error: they are authorized to use the route (`order:fulfill:org`), they
 * simply own nothing. Neither case ever issues an unscoped query.
 */
@Injectable()
export class ListPharmacyOrdersQuery {
  constructor(
    @Inject(FULFILLMENT_REPOSITORY) private readonly fulfillments: IFulfillmentRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
  ) {}

  async execute(input: ListPharmacyOrdersInput): Promise<PagedResult<FulfillmentSnapshot>> {
    const organizationIds = await this.identity.getUserOrganizationIds(input.actorUserId);
    if (organizationIds.length === 0) {
      return { items: [], total: 0 };
    }

    const pharmacyIds = await this.pharmacies.findPharmacyIdsByOrganizationIds(organizationIds);
    if (pharmacyIds.length === 0) {
      return { items: [], total: 0 };
    }

    return this.fulfillments.listByPharmacyIds({
      pharmacyIds,
      status: input.status,
      page: input.page,
      size: input.size,
    });
  }
}
