import { StagingSeeder } from '../../src/cli/staging-seed/staging-seeder';
import {
  FIXTURE_ACCOUNTS,
  FIXTURE_DISPUTE_REASON,
  FIXTURE_FEATURE_FLAG,
  FIXTURE_ORDERS,
  FIXTURE_ORGANIZATIONS,
  FIXTURE_PRODUCTS,
} from '../../src/cli/staging-seed/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Work 80: the staging verification baseline, built by the real application commands against real
 * PostgreSQL. The CLI's staging guard is covered by its unit spec; here the seeder runs directly
 * against the disposable test database.
 *
 * What only this can show: that every fixture state is reachable through the commands the seed
 * calls (in the order it calls them), and that a second run changes nothing.
 */
describe('Staging seed (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const lines: string[] = [];
  const seed = () => new StagingSeeder(ctx.app, (line) => lines.push(line)).run();

  /** Row counts of every table the seed writes, to prove the second run is a no-op. */
  async function counts() {
    const p = ctx.prisma;
    return {
      users: await p.user.count(),
      userRoles: await p.userRole.count(),
      organizations: await p.organization.count(),
      verifications: await p.verificationRequest.count(),
      pharmacies: await p.pharmacy.count(),
      branches: await p.branch.count(),
      products: await p.product.count(),
      orders: await p.order.count(),
      payments: await p.payment.count(),
      refunds: await p.refund.count(),
      settlements: await p.settlement.count(),
      jobs: await p.deliveryJob.count(),
      collections: await p.codCollection.count(),
      disputes: await p.codDispute.count(),
      flags: await p.featureFlag.count(),
    };
  }

  it('creates every fixture state on the first run, and changes nothing on the second', async () => {
    const first = await seed();
    expect(first.created.length).toBeGreaterThan(0);
    const afterFirst = await counts();
    const auditAfterFirst = await ctx.prisma.auditLog.count();

    const second = await seed();
    expect(second.created).toEqual([]);
    expect(await counts()).toEqual(afterFirst);
    // Replays write no new audit entries either.
    expect(await ctx.prisma.auditLog.count()).toBe(auditAfterFirst);
  });

  it('leaves the accounts active, verified and without a password', async () => {
    for (const account of FIXTURE_ACCOUNTS) {
      const user = await ctx.prisma.user.findFirstOrThrow({
        where: account.email ? { email: account.email } : { phone: account.phone },
        include: { userRoles: { include: { role: true } } },
      });
      expect(user.status).toBe('ACTIVE');
      expect(user.passwordHash).toBeNull();
      expect(user.primaryRole).toBe(account.primaryRole);
      if (account.email) expect(user.emailVerifiedAt).not.toBeNull();
      if (account.roleKey) expect(user.userRoles.map((r) => r.role.key)).toContain(account.roleKey);
    }
  });

  it('leaves one organisation per lifecycle state, and a per-round copy of each one-shot fixture', async () => {
    const expected: Record<string, { org: string; pharmacy?: string }> = {
      ACTIVE_TRANSACTING: { org: 'ACTIVE', pharmacy: 'ACTIVE' },
      ACTIVE_NOT_ACTIVATED: { org: 'ACTIVE', pharmacy: 'PENDING' },
      PENDING_APPROVAL: { org: 'PENDING_APPROVAL' },
      REJECTED: { org: 'REJECTED' },
      SUSPENDED: { org: 'SUSPENDED' },
    };
    for (const fixture of FIXTURE_ORGANIZATIONS) {
      const org = await ctx.prisma.organization.findFirstOrThrow({ where: { name: fixture.legalName } });
      expect({ key: fixture.key, status: org.status }).toEqual({ key: fixture.key, status: expected[fixture.outcome].org });
      if (fixture.licenseNumber) {
        expect(org.licenseNumber).toBe(fixture.licenseNumber);
        expect(org.licenseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      }
      const pharmacy = await ctx.prisma.pharmacy.findUnique({ where: { organizationId: org.id } });
      if (expected[fixture.outcome].pharmacy) expect(pharmacy?.transactingStatus).toBe(expected[fixture.outcome].pharmacy);
    }
  });

  it('leaves a pending verification of every type', async () => {
    const pending = await ctx.prisma.verificationRequest.groupBy({ by: ['type'], where: { status: 'PENDING' }, _count: true });
    const byType = Object.fromEntries(pending.map((p) => [p.type, p._count]));
    // Two of each: one per walk round (Admin, Super Admin).
    expect(byType).toEqual({ PHARMACY_LICENSE: 4, FAYDA: 2, DRIVER_DOCS: 2, DOCTOR_LICENSE: 2 });
  });

  it('leaves a product in every catalogue status', async () => {
    for (const fixture of FIXTURE_PRODUCTS) {
      const product = await ctx.prisma.product.findFirstOrThrow({ where: { nameEn: fixture.nameEn } });
      expect({ key: fixture.key, status: product.status }).toEqual({ key: fixture.key, status: fixture.outcome });
    }
    const statuses = new Set(FIXTURE_PRODUCTS.map((p) => p.outcome));
    expect(statuses).toEqual(new Set(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'DEPRECATED', 'DELISTED']));
  });

  it('leaves payments, refunds, a settlement and COD collections with one open dispute', async () => {
    const payments = new Map<string, string>();
    for (const fixture of FIXTURE_ORDERS.filter((o) => !o.isCod)) {
      const order = await ctx.prisma.order.findUniqueOrThrow({ where: { orderNumber: fixture.orderNumber } });
      const payment = await ctx.prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      payments.set(fixture.key, payment.status);
    }
    expect(Object.fromEntries(payments)).toEqual({
      captured: 'CAPTURED',
      partialRefund: 'PARTIALLY_REFUNDED',
      fullRefund: 'REFUNDED',
      authorizedOnly: 'AUTHORIZED',
    });
    expect(await ctx.prisma.refund.count()).toBe(2);
    expect(await ctx.prisma.settlement.count()).toBe(1);

    const collections = await ctx.prisma.codCollection.findMany({ include: { disputes: true } });
    expect(collections).toHaveLength(3);
    const disputes = collections.flatMap((c) => c.disputes);
    // One open dispute per walk round.
    expect(disputes).toHaveLength(2);
    for (const dispute of disputes) expect(dispute).toMatchObject({ status: 'OPEN', reason: FIXTURE_DISPUTE_REASON });
  });

  it('creates the walk feature flag switched off', async () => {
    const flag = await ctx.prisma.featureFlag.findUniqueOrThrow({ where: { key: FIXTURE_FEATURE_FLAG } });
    expect(flag.status).not.toBe('ON');
  });
});
