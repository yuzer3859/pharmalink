import request from 'supertest';
import { auth, body, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, grantOrgRole, PharmacyOwnerContext } from '../pharmacy-inventory/support';
import { createCustomer } from '../orders/support';

interface StaffList {
  organizationId: string;
  items: Array<{ userId: string; email: string | null; roles: Array<{ roleKey: string }> }>;
  assignableRoles: Array<{ key: string; name: string; permissionKeys: string[] }>;
}

/**
 * Work 113: a pharmacy's staff (module-04 §9.2). The owner or a manager gives an existing
 * account a staff role by e-mail, lists the members, and takes a staff role away. The owner role
 * is never handed out or removed, and nobody changes their own roles.
 */
describe('Pharmacy staff (Work 113, e2e)', () => {
  let ctx: TestContext;
  let owner: PharmacyOwnerContext;
  let otherOwner: PharmacyOwnerContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
    owner = await createActivatedPharmacy(ctx);
    otherOwner = await createActivatedPharmacy(ctx);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const as = (token: string) => ({
    get: (path: string) => request(ctx.server).get(path).set(...auth(token)),
    post: (path: string, payload: object) => request(ctx.server).post(path).set(...auth(token)).send(payload),
    delete: (path: string) => request(ctx.server).delete(path).set(...auth(token)),
  });

  async function accountWithEmail(email: string) {
    const person = await createCustomer(ctx);
    await ctx.prisma.user.update({ where: { id: person.userId }, data: { email } });
    return person;
  }

  it('lists the members of the caller’s own pharmacy and the roles that can be given', async () => {
    const list = body(await as(owner.accessToken).get('/pharmacy/staff').expect(200)) as unknown as StaffList;
    expect(list.organizationId).toBe(owner.organizationId);
    expect(list.items.map((m) => m.userId)).toEqual([owner.userId]);
    expect(list.items[0].roles.map((r) => r.roleKey)).toContain('PHARMACY_OWNER');
    expect(list.assignableRoles.map((r) => r.key)).toEqual(['PHARMACY_MANAGER', 'PHARMACIST', 'CASHIER', 'INVENTORY_STAFF']);
    // What each role allows comes from the RBAC catalogue itself.
    expect(list.assignableRoles.find((r) => r.key === 'PHARMACIST')?.permissionKeys).toContain('prescription:verify');
    expect(list.assignableRoles.every((r) => r.name.length > 0)).toBe(true);
  });

  it('gives an existing account a staff role by e-mail, audited, once', async () => {
    const person = await accountWithEmail('new.pharmacist@example.test');

    await as(owner.accessToken).post('/pharmacy/staff', { email: ' New.Pharmacist@example.test ', roleKey: 'PHARMACIST' }).expect(201);
    const list = body(await as(owner.accessToken).get('/pharmacy/staff').expect(200)) as unknown as StaffList;
    expect(list.items.find((m) => m.userId === person.userId)?.roles.map((r) => r.roleKey)).toEqual(['PHARMACIST']);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'rbac.user_role.assigned', resourceId: person.userId, actorUserId: owner.userId } })).toBe(1);

    const again = await as(owner.accessToken).post('/pharmacy/staff', { email: 'new.pharmacist@example.test', roleKey: 'PHARMACIST' }).expect(409);
    expect(errorOf(again).code).toBe('CONFLICT');
  });

  it('refuses an unknown e-mail, the owner role, and the caller themselves', async () => {
    const unknown = await as(owner.accessToken).post('/pharmacy/staff', { email: 'nobody@example.test', roleKey: 'CASHIER' }).expect(404);
    expect(errorOf(unknown).message).toMatch(/sign up first/);
    await as(owner.accessToken).post('/pharmacy/staff', { email: 'new.pharmacist@example.test', roleKey: 'PHARMACY_OWNER' }).expect(400);
    await ctx.prisma.user.update({ where: { id: owner.userId }, data: { email: 'the.owner@example.test' } });
    await as(owner.accessToken).post('/pharmacy/staff', { email: 'the.owner@example.test', roleKey: 'CASHIER' }).expect(403);
  });

  it('takes a staff role away, but never the owner role or the caller’s own', async () => {
    const person = await accountWithEmail('cashier@example.test');
    await as(owner.accessToken).post('/pharmacy/staff', { email: 'cashier@example.test', roleKey: 'CASHIER' }).expect(201);

    await as(owner.accessToken).delete(`/pharmacy/staff/${person.userId}/roles/CASHIER`).expect(204);
    const list = body(await as(owner.accessToken).get('/pharmacy/staff').expect(200)) as unknown as StaffList;
    expect(list.items.some((m) => m.userId === person.userId)).toBe(false);
    await as(owner.accessToken).delete(`/pharmacy/staff/${person.userId}/roles/CASHIER`).expect(404);

    await as(owner.accessToken).delete(`/pharmacy/staff/${owner.userId}/roles/PHARMACY_OWNER`).expect(403);
    const manager = await grantOrgRole(ctx, 'PHARMACY_MANAGER', owner.organizationId);
    await as(manager.accessToken).delete(`/pharmacy/staff/${owner.userId}/roles/PHARMACY_OWNER`).expect(403);
    await as(manager.accessToken).delete(`/pharmacy/staff/${manager.userId}/roles/PHARMACY_MANAGER`).expect(403);
  });

  it('a manager manages staff too; another pharmacy’s member is out of reach', async () => {
    const manager = await grantOrgRole(ctx, 'PHARMACY_MANAGER', owner.organizationId);
    const person = await accountWithEmail('stock@example.test');
    await as(manager.accessToken).post('/pharmacy/staff', { email: 'stock@example.test', roleKey: 'INVENTORY_STAFF' }).expect(201);

    // The other pharmacy cannot see or remove this pharmacy's staff.
    const theirs = body(await as(otherOwner.accessToken).get('/pharmacy/staff').expect(200)) as unknown as StaffList;
    expect(theirs.items.some((m) => m.userId === person.userId)).toBe(false);
    await as(otherOwner.accessToken).delete(`/pharmacy/staff/${person.userId}/roles/INVENTORY_STAFF`).expect(404);
  });

  it('a pharmacist without staff:manage:org and a customer are refused', async () => {
    const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', owner.organizationId);
    await as(pharmacist.accessToken).get('/pharmacy/staff').expect(403);
    const customer = await createCustomer(ctx);
    await as(customer.accessToken).get('/pharmacy/staff').expect(403);
  });
});
