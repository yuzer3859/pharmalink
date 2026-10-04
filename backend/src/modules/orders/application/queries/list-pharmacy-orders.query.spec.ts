import { IFulfillmentRepository } from '../../domain/repositories/fulfillment.repository';
import { IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort } from '../ports/outbound/pharmacy.port';
import { ListPharmacyOrdersQuery } from './list-pharmacy-orders.query';

/** Organization ids and pharmacy ids are deliberately distinct values — conflating them is the
 * defect this query's two-hop resolution exists to avoid. */
const ORG_IDS = ['organization-1', 'organization-2'];
const PHARMACY_IDS = ['pharmacy-a', 'pharmacy-b'];

describe('ListPharmacyOrdersQuery', () => {
  function build() {
    const fulfillments = {
      listByPharmacyIds: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    } as unknown as jest.Mocked<IFulfillmentRepository>;
    const identity: jest.Mocked<IIdentityPort> = {
      getUserOrganizationIds: jest.fn().mockResolvedValue(ORG_IDS),
      hasRoleAtOrganization: jest.fn(),
    };
    const pharmacies: jest.Mocked<IPharmacyPort> = {
      getOrganizationId: jest.fn(),
      findPharmacyIdsByOrganizationIds: jest.fn().mockResolvedValue(PHARMACY_IDS),
    };
    return {
      query: new ListPharmacyOrdersQuery(fulfillments, identity, pharmacies),
      fulfillments,
      identity,
      pharmacies,
    };
  }

  it('resolves the caller’s organizations to pharmacy ids before querying', async () => {
    const { query, fulfillments, identity, pharmacies } = build();

    await query.execute({ actorUserId: 'user-1', page: 1, size: 20 });

    expect(identity.getUserOrganizationIds).toHaveBeenCalledWith('user-1');
    expect(pharmacies.findPharmacyIdsByOrganizationIds).toHaveBeenCalledWith(ORG_IDS);
    // The repository must be given Pharmacy.ids, never the Organization.ids.
    expect(fulfillments.listByPharmacyIds).toHaveBeenCalledWith({
      pharmacyIds: PHARMACY_IDS,
      status: undefined,
      page: 1,
      size: 20,
    });
  });

  it('passes the status filter and paging through unchanged', async () => {
    const { query, fulfillments } = build();

    await query.execute({ actorUserId: 'user-1', status: 'ACCEPTED', page: 3, size: 5 });

    expect(fulfillments.listByPharmacyIds).toHaveBeenCalledWith({
      pharmacyIds: PHARMACY_IDS,
      status: 'ACCEPTED',
      page: 3,
      size: 5,
    });
  });

  it('returns an empty page without querying when the caller belongs to no organization', async () => {
    const { query, fulfillments, identity, pharmacies } = build();
    identity.getUserOrganizationIds.mockResolvedValue([]);

    const result = await query.execute({ actorUserId: 'user-1', page: 1, size: 20 });

    expect(result).toEqual({ items: [], total: 0 });
    expect(pharmacies.findPharmacyIdsByOrganizationIds).not.toHaveBeenCalled();
    expect(fulfillments.listByPharmacyIds).not.toHaveBeenCalled();
  });

  it('returns an empty page when the caller’s organizations own no pharmacy', async () => {
    const { query, fulfillments, pharmacies } = build();
    pharmacies.findPharmacyIdsByOrganizationIds.mockResolvedValue([]);

    const result = await query.execute({ actorUserId: 'user-1', page: 1, size: 20 });

    // An empty pharmacyIds list would otherwise become an unscoped `IN ()` query.
    expect(result).toEqual({ items: [], total: 0 });
    expect(fulfillments.listByPharmacyIds).not.toHaveBeenCalled();
  });
});
