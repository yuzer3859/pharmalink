import { driver, pharmacist, pharmacy, verifyCustomer } from '../../src/cli/staging-actors';
import { StagingSeeder } from '../../src/cli/staging-seed/staging-seeder';
import { FIXTURE_ORGANIZATIONS } from '../../src/cli/staging-seed/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Work 103: the Phase 1 walk's seed (stock a customer can buy, a pharmacist at the walk pharmacy)
 * and the `staging:actors` CLI's refusals. The actors' happy path runs the same commands as
 * `test/phase1/marketplace.e2e-spec.ts` and is walked live on staging.
 */
describe('Staging walk: marketplace seed and actors (Work 103, e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
    await new StagingSeeder(ctx.app, () => undefined).run();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('stocks the OTC walk product and the Rx Amoxicillin at Bole Main, priced, and makes the owner a pharmacist there', async () => {
    const org = await ctx.prisma.organization.findFirstOrThrow({ where: { name: FIXTURE_ORGANIZATIONS.find((o) => o.key === 'transacting')!.legalName } });
    const pharmacyRow = await ctx.prisma.pharmacy.findUniqueOrThrow({ where: { organizationId: org.id } });
    const listings = await ctx.prisma.inventoryListing.findMany({ where: { pharmacyId: pharmacyRow.id } });
    const products = await ctx.prisma.product.findMany({ where: { id: { in: listings.map((l) => l.catalogProductId) } } });
    expect(products.map((p) => [p.nameEn, p.status, p.rxClassification, p.price !== null]).sort()).toEqual(
      [
        ['Seed Amoxicillin 500 mg capsule', 'ACTIVE', 'RX', true],
        ['Seed ORS oral rehydration sachet', 'ACTIVE', 'OTC', true],
      ].sort(),
    );
    expect(listings.every((l) => l.sellable === 200)).toBe(true);
    const role = await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'PHARMACIST' } });
    expect(await ctx.prisma.userRole.count({ where: { userId: org.ownerUserId, roleId: role.id, organizationId: org.id } })).toBe(1);
  });

  it('a second seed run changes nothing', async () => {
    const summary = await new StagingSeeder(ctx.app, () => undefined).run();
    expect(summary.created).toEqual([]);
  });

  it('the actors refuse clearly when there is nothing to act on', async () => {
    const log = () => undefined;
    await expect(pharmacy(ctx.app, 'NO-SUCH-ORDER', log)).rejects.toThrow('No order NO-SUCH-ORDER.');
    await expect(driver(ctx.app, 'NO-SUCH-ORDER', log, 0)).rejects.toThrow('No order NO-SUCH-ORDER.');
    await expect(pharmacist(ctx.app, 'nobody@staging.pharmalink.test', log)).rejects.toThrow('No customer');
  });

  it('verify-customer verifies only a new customer, once, with an audit entry (Work 105)', async () => {
    const log = () => undefined;
    const email = 'walk.customer@staging.pharmalink.test';
    const created = await ctx.prisma.user.create({ data: { email, primaryRole: 'CUSTOMER' } });
    expect(created.status).toBe('PENDING_VERIFICATION');

    await verifyCustomer(ctx.app, 'Walk.Customer@staging.pharmalink.test', log);

    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(await ctx.prisma.auditLog.count({ where: { action: 'staging.customer.email_verified', resourceId: created.id } })).toBe(1);

    await expect(verifyCustomer(ctx.app, email, log)).rejects.toThrow('is not waiting for verification');
    await expect(verifyCustomer(ctx.app, 'nobody@staging.pharmalink.test', log)).rejects.toThrow('No account');
    const owner = FIXTURE_ORGANIZATIONS.find((o) => o.key === 'transacting')!;
    const org = await ctx.prisma.organization.findFirstOrThrow({ where: { name: owner.legalName }, include: { owner: true } });
    await expect(verifyCustomer(ctx.app, org.owner.email!, log)).rejects.toThrow('is not a customer account');
  });
});
