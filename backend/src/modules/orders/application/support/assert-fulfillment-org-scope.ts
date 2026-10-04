import { OrdersErrors } from '../../domain/errors';
import { IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort } from '../ports/outbound/pharmacy.port';

/**
 * Roles granted `order:fulfill:org` (module-06 `06-orders-spec.md` §7.1's RBAC table) — the same
 * three organization roles the permission is seeded against. `IIdentityPort.hasRoleAtOrganization`
 * only answers one role at a time (mirrors module-05's `IIdentityPort` shape exactly), so the
 * org-scope check tries each in turn and succeeds the moment one matches.
 */
export const FULFILLMENT_ROLE_KEYS = ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'PHARMACIST'] as const;

/**
 * Org-scoping guard for every pharmacy fulfillment action (`AcceptFulfillmentCommand`/
 * `DeclineFulfillmentCommand`/`PrepareFulfillmentCommand`/`MarkReadyCommand`, §5/§7.1/§9.4).
 *
 * **Both identifiers come from persisted state, never from the request.** The caller supplies
 * only their authenticated `actorUserId`; `pharmacyId` is read off the `Fulfillment` row the
 * command already loaded. A client cannot name the pharmacy or organization it wants to be
 * scoped to.
 *
 * The check is two hops, because the two ids involved live in different bounded contexts:
 *  1. `Fulfillment.pharmacyId` is a **`Pharmacy.id`** (Module 04). `Pharmacy.organizationId`
 *     (`String @unique`) is the only link to Module 01's organizations, so `IPharmacyPort`
 *     resolves it.
 *  2. Role grants live in `user_roles.organizationId`, an **`Organization.id`**, so
 *     `IIdentityPort.hasRoleAtOrganization` is asked about that resolved organization.
 *
 * Passing the `Pharmacy.id` straight to `hasRoleAtOrganization` — as this helper previously did —
 * compares a pharmacy id against organization ids. They are distinct uuids, so the check could
 * never succeed against real data and every fulfillment action failed closed. It went unnoticed
 * because the commands' unit tests mocked `hasRoleAtOrganization` to `true`.
 *
 * Every failure mode — unknown/deleted pharmacy, no matching role, or a role held at a different
 * organization — throws the same generic not-found a missing fulfillment would, so no caller can
 * learn that another organization's fulfillment exists (§7's no-existence-leakage discipline,
 * mirroring module-05's `GetPrescriptionQuery`).
 */
export async function assertFulfillmentOrgScope(
  identity: IIdentityPort,
  pharmacies: IPharmacyPort,
  actorUserId: string,
  pharmacyId: string,
): Promise<void> {
  const organizationId = await pharmacies.getOrganizationId(pharmacyId);
  if (!organizationId) {
    throw OrdersErrors.notFound('Fulfillment not found.');
  }

  for (const roleKey of FULFILLMENT_ROLE_KEYS) {
    if (await identity.hasRoleAtOrganization(actorUserId, organizationId, roleKey)) {
      return;
    }
  }
  throw OrdersErrors.notFound('Fulfillment not found.');
}
