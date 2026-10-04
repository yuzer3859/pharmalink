import { IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort } from '../ports/outbound/pharmacy.port';
import { assertFulfillmentOrgScope } from './assert-fulfillment-org-scope';

/**
 * The two ids in play are deliberately distinct throughout, because conflating them is the exact
 * defect this guard had: `Fulfillment.pharmacyId` is a `Pharmacy.id`, while role grants live in
 * `user_roles.organizationId`, an `Organization.id`. A test that used the same value for both
 * would pass against the broken implementation too.
 */
const PHARMACY_ID = 'pharmacy-aaa';
const ORGANIZATION_ID = 'organization-zzz';
const OTHER_ORGANIZATION_ID = 'organization-yyy';

function identity(
  grants: Array<{ organizationId: string; roleKey: string }> = [],
): jest.Mocked<IIdentityPort> {
  return {
    getUserOrganizationIds: jest.fn(),
    hasRoleAtOrganization: jest
      .fn()
      .mockImplementation(async (_userId: string, organizationId: string, roleKey: string) =>
        grants.some((g) => g.organizationId === organizationId && g.roleKey === roleKey),
      ),
  };
}

function pharmacies(
  mapping: Record<string, string> = { [PHARMACY_ID]: ORGANIZATION_ID },
): jest.Mocked<IPharmacyPort> {
  return {
    getOrganizationId: jest
      .fn()
      .mockImplementation(async (pharmacyId: string) => mapping[pharmacyId] ?? null),
    findPharmacyIdsByOrganizationIds: jest.fn().mockResolvedValue([]),
  };
}

describe('assertFulfillmentOrgScope', () => {
  it.each(['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'PHARMACIST'])(
    'allows a %s holding the role at the organization that owns the fulfillment’s pharmacy',
    async (roleKey) => {
      const id = identity([{ organizationId: ORGANIZATION_ID, roleKey }]);
      const ph = pharmacies();

      await expect(
        assertFulfillmentOrgScope(id, ph, 'user-1', PHARMACY_ID),
      ).resolves.toBeUndefined();

      // The role check must be asked about the resolved Organization.id, never the Pharmacy.id.
      expect(ph.getOrganizationId).toHaveBeenCalledWith(PHARMACY_ID);
      for (const call of id.hasRoleAtOrganization.mock.calls) {
        expect(call[1]).toBe(ORGANIZATION_ID);
        expect(call[1]).not.toBe(PHARMACY_ID);
      }
    },
  );

  it('denies a user holding the right role at a different organization', async () => {
    const id = identity([{ organizationId: OTHER_ORGANIZATION_ID, roleKey: 'PHARMACY_OWNER' }]);

    await expect(
      assertFulfillmentOrgScope(id, pharmacies(), 'user-1', PHARMACY_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('denies a user holding the right role at an organization that owns an unrelated pharmacy', async () => {
    // The actor genuinely runs organization-yyy, which owns pharmacy-bbb — but the fulfillment
    // belongs to pharmacy-aaa, owned by organization-zzz.
    const id = identity([{ organizationId: OTHER_ORGANIZATION_ID, roleKey: 'PHARMACIST' }]);
    const ph = pharmacies({
      [PHARMACY_ID]: ORGANIZATION_ID,
      'pharmacy-bbb': OTHER_ORGANIZATION_ID,
    });

    await expect(assertFulfillmentOrgScope(id, ph, 'user-1', PHARMACY_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('denies a user holding no fulfillment role at all', async () => {
    await expect(
      assertFulfillmentOrgScope(identity(), pharmacies(), 'user-1', PHARMACY_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('denies a role that is not one of the three fulfillment roles', async () => {
    const id = identity([{ organizationId: ORGANIZATION_ID, roleKey: 'CASHIER' }]);

    await expect(
      assertFulfillmentOrgScope(id, pharmacies(), 'user-1', PHARMACY_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports an unknown or deleted pharmacy as the same generic not-found', async () => {
    const id = identity([{ organizationId: ORGANIZATION_ID, roleKey: 'PHARMACY_OWNER' }]);
    const ph = pharmacies({});

    await expect(assertFulfillmentOrgScope(id, ph, 'user-1', PHARMACY_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Fails closed before any role lookup — an unresolvable pharmacy is never treated as allowed.
    expect(id.hasRoleAtOrganization).not.toHaveBeenCalled();
  });

  it('does not leak cross-organization existence: denial is identical whether the pharmacy exists or not', async () => {
    const id = identity([{ organizationId: OTHER_ORGANIZATION_ID, roleKey: 'PHARMACY_OWNER' }]);

    async function denial(port: jest.Mocked<IPharmacyPort>): Promise<{
      code: string;
      message: string;
    }> {
      try {
        await assertFulfillmentOrgScope(id, port, 'user-1', PHARMACY_ID);
        throw new Error('expected the scope check to reject');
      } catch (err) {
        return err as { code: string; message: string };
      }
    }

    // A pharmacy that exists but belongs to someone else, versus one that does not exist at all.
    const existsButForbidden = await denial(pharmacies());
    const doesNotExist = await denial(pharmacies({}));

    expect(existsButForbidden.code).toBe(doesNotExist.code);
    expect(existsButForbidden.message).toBe(doesNotExist.message);
  });

  it('takes the organization only from the persisted pharmacy, so a caller cannot supply its own', async () => {
    // The guard's signature accepts no organization argument at all: the only inputs are the
    // authenticated actor and the pharmacyId read off the persisted Fulfillment row. Even when
    // the actor holds the role at an organization they control, access is decided by what
    // IPharmacyPort says owns this pharmacy.
    const id = identity([
      { organizationId: OTHER_ORGANIZATION_ID, roleKey: 'PHARMACY_OWNER' },
      { organizationId: ORGANIZATION_ID, roleKey: 'PHARMACY_OWNER' },
    ]);
    const ph = pharmacies({ [PHARMACY_ID]: OTHER_ORGANIZATION_ID });

    await expect(assertFulfillmentOrgScope(id, ph, 'user-1', PHARMACY_ID)).resolves.toBeUndefined();
    expect(ph.getOrganizationId).toHaveBeenCalledWith(PHARMACY_ID);
    expect(id.hasRoleAtOrganization).toHaveBeenCalledWith(
      'user-1',
      OTHER_ORGANIZATION_ID,
      'PHARMACY_OWNER',
    );
  });
});
