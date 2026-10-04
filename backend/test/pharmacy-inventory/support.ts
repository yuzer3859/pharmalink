import { randomUUID } from 'crypto';
import request from 'supertest';
import {
  auth,
  body,
  createUserWithRole,
  grantRoleDirect,
  login,
  registerAndVerify,
  RegisteredUser,
  Tokens,
} from '../support/fixtures';
import { TestContext } from '../support/test-app';

/**
 * Seeds a Module 01 `Organization(type=PHARMACY)` directly via Prisma. Module 01 has no
 * organization-registration HTTP endpoint yet (confirmed by inspection of
 * `src/modules/identity/interface/controllers` — no such route exists in this codebase today),
 * so e2e tests seed the pre-condition directly, exactly like `grantRoleDirect` already seeds
 * role assignments. This mirrors the "client orchestrates two calls" pattern (module-04 §14.1)
 * without inventing an out-of-scope Module 01 endpoint.
 */
export async function createPharmacyOrganization(
  ctx: TestContext,
  ownerUserId: string,
  overrides: { licenseExpiresAt?: Date | null; name?: string } = {},
): Promise<{ organizationId: string }> {
  const org = await ctx.prisma.organization.create({
    data: {
      id: randomUUID(),
      type: 'PHARMACY',
      name: overrides.name ?? 'Test Pharmacy Org',
      status: 'ACTIVE',
      ownerUserId,
      licenseNumber: 'LIC-0001',
      licenseExpiresAt: overrides.licenseExpiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });
  return { organizationId: org.id };
}

export interface PharmacyOwnerContext extends RegisteredUser, Tokens {
  organizationId: string;
  pharmacyId: string;
}

/**
 * A `PHARMACY_OWNER` user, org-scoped to a freshly created `Organization(PHARMACY)`, with a
 * registered + activated `Pharmacy`, ready to manage branches/listings (module-04 §4, §10.1).
 * The `PHARMACY_OWNER` role grant is scoped to this organization (`user_roles.organizationId`)
 * so `IIdentityPort.getUserOrganizationIds` (§15 org-scope resolution) finds it.
 */
export async function createActivatedPharmacy(
  ctx: TestContext,
  overrides: { licenseExpiresAt?: Date | null } = {},
): Promise<PharmacyOwnerContext> {
  const owner = await registerAndVerify(ctx);
  const { organizationId } = await createPharmacyOrganization(ctx, owner.userId, overrides);
  await grantRoleDirect(ctx, owner.userId, 'PHARMACY_OWNER', organizationId);
  const tokens = await login(ctx, owner.phone, owner.password);

  const registered = body(
    await request(ctx.server)
      .post('/pharmacy/register')
      .set(...auth(tokens.accessToken))
      .send({ organizationId, displayName: 'Test Pharmacy' })
      .expect(201),
  );
  const pharmacyId = registered.pharmacyId as string;

  const admin = await createUserWithRole(ctx, 'ADMIN');
  await request(ctx.server)
    .post('/pharmacy/activate')
    .set(...auth(admin.accessToken))
    .send({ pharmacyId })
    .expect(201);

  return { ...owner, ...tokens, organizationId, pharmacyId };
}

/** Grants an additional org-scoped role (e.g. `PHARMACY_MANAGER`) to an existing pharmacy's organization. */
export async function grantOrgRole(
  ctx: TestContext,
  roleKey: string,
  organizationId: string,
): Promise<RegisteredUser & Tokens> {
  const user = await registerAndVerify(ctx);
  await grantRoleDirect(ctx, user.userId, roleKey, organizationId);
  const tokens = await login(ctx, user.phone, user.password);
  return { ...user, ...tokens };
}
