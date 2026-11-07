import { randomUUID } from 'crypto';
import request from 'supertest';
import { PricingCalculator } from '../../src/modules/orders/domain/services/pricing-calculator';
import { codSaleLedgerReference } from '../../src/modules/payment/application/services/cod-accounting.service';
import { SettlementAutoRunService } from '../../src/modules/payment/application/services/settlement-auto-run.service';
import { CodRemittedHandler } from '../../src/modules/payment/interface/events/cod-remitted.handler';
import { ConfigOverrideLoader } from '../../src/modules/admin/infrastructure/config/config-override.loader';
import { CONFIG_PORT, IConfigPort } from '../../src/shared/config/config.port';
import { createActivatedPharmacy, PharmacyOwnerContext } from '../pharmacy-inventory/support';
import { auth, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Work 97 (owner's decision 2026-11-07): COD money reaches the ledger only when the cash reaches
 * PharmaLink (`delivery.cod.remitted`), for the amount handed over; and a pharmacy's settlement
 * statement is generated automatically by an amount threshold or a period, whichever comes first,
 * both editable in Module 16's configuration.
 */
describe('COD ledger postings and automatic settlement triggers (Work 97, e2e)', () => {
  let ctx: TestContext;
  let config: IConfigPort;
  let loader: ConfigOverrideLoader;
  let owner: PharmacyOwnerContext;
  let customer: RegisteredUser & Tokens;
  let superAdmin: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    config = ctx.app.get(CONFIG_PORT);
    loader = ctx.app.get(ConfigOverrideLoader);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    await loader.refresh();
    owner = await createActivatedPharmacy(ctx);
    customer = await createUserWithRole(ctx, 'CUSTOMER');
    superAdmin = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
  });

  /** A delivered COD order for the owner's pharmacy, as checkout and delivery leave it. */
  async function deliveredCodOrder(subtotal = 9_000): Promise<{ orderId: string; grandTotal: number; platformFee: number }> {
    const totals = PricingCalculator.computeTotals({
      lines: [{ unitPrice: subtotal, quantity: 1 }],
      deliveryFee: 1_000,
      platformFeePercent: config.get<number>('orders.platformFeePercent') ?? 0,
      discountTotal: 0,
    });
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: customer.userId,
        status: 'DELIVERED',
        subtotal: totals.subtotal,
        deliveryFee: totals.deliveryFee,
        platformFee: totals.platformFee,
        discountTotal: totals.discountTotal,
        grandTotal: totals.grandTotal,
        currency: totals.currency,
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: true,
      },
    });
    await ctx.prisma.fulfillment.create({ data: { orderId: order.id, pharmacyId: owner.pharmacyId, branchId: `branch-${randomUUID()}` } });
    return { orderId: order.id, grandTotal: totals.grandTotal, platformFee: totals.platformFee };
  }

  function remitted(orderId: string, remittedAmount: number, remittanceId = randomUUID()) {
    return {
      id: randomUUID(),
      payload: {
        remittanceId,
        collectionId: randomUUID(),
        jobId: randomUUID(),
        orderId,
        fulfillmentId: randomUUID(),
        driverId: randomUUID(),
        expectedAmount: remittedAmount,
        collectedAmount: remittedAmount,
        remittedAmount,
        currency: 'ETB',
        method: 'CASH',
        providerReference: null,
        reference: 'handover-1',
        confirmedByUserId: randomUUID(),
        remittedAt: new Date().toISOString(),
      },
    } as never;
  }

  const posting = (remittanceId: string) =>
    ctx.prisma.ledgerTransaction.findUnique({
      where: { reference: codSaleLedgerReference(remittanceId) },
      include: { entries: { include: { account: true } } },
    });

  const setConfig = (key: string, value: number) =>
    request(ctx.server).put(`/admin/config/settlement/${key}`).set(...auth(superAdmin)).send({ valueType: 'INTEGER', value }).expect(200);

  describe('COD sale when the cash reaches PharmaLink', () => {
    it('posts the sale for the amount handed over: COD clearing against the pharmacy payable and the commission, once', async () => {
      const order = await deliveredCodOrder();
      const remittanceId = randomUUID();
      const handler = ctx.app.get(CodRemittedHandler);
      await handler.handle(remitted(order.orderId, order.grandTotal, remittanceId));
      await handler.handle(remitted(order.orderId, order.grandTotal, remittanceId));

      const tx = await posting(remittanceId);
      expect(tx).toMatchObject({ type: 'COD_SALE', refType: 'cod_remittance', refId: remittanceId });
      const legs = Object.fromEntries(tx!.entries.map((e) => [`${e.account.type}:${e.direction}`, e.amount]));
      expect(legs).toEqual({
        'COD_CLEARING:DEBIT': order.grandTotal,
        'PROVIDER_PAYABLE:CREDIT': order.grandTotal - order.platformFee,
        ...(order.platformFee > 0 ? { 'PLATFORM_REVENUE:CREDIT': order.platformFee } : {}),
      });
      expect(tx!.entries.find((e) => e.account.type === 'PROVIDER_PAYABLE')?.account.ownerId).toBe(owner.pharmacyId);
      expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'COD_SALE' } })).toBe(1);
    });

    it('a short handover pays the pharmacy only what reached PharmaLink; an overage is capped at the order total', async () => {
      const short = await deliveredCodOrder();
      const shortId = randomUUID();
      await ctx.app.get(CodRemittedHandler).handle(remitted(short.orderId, short.grandTotal - 2_000, shortId));
      const shortLegs = (await posting(shortId))!.entries;
      expect(shortLegs.find((e) => e.account.type === 'PROVIDER_PAYABLE')?.amount).toBe(short.grandTotal - 2_000 - short.platformFee);

      const over = await deliveredCodOrder();
      const overId = randomUUID();
      await ctx.app.get(CodRemittedHandler).handle(remitted(over.orderId, over.grandTotal + 5_000, overId));
      expect((await posting(overId))!.entries.find((e) => e.account.type === 'COD_CLEARING')?.amount).toBe(over.grandTotal);
    });

    it('posts nothing for a handover smaller than the commission, or for an unknown order', async () => {
      const order = await deliveredCodOrder();
      const handler = ctx.app.get(CodRemittedHandler);
      if (order.platformFee > 0) await handler.handle(remitted(order.orderId, order.platformFee - 1));
      await handler.handle(remitted(randomUUID(), 5_000));
      expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'COD_SALE' } })).toBe(0);
    });

    it('nothing is posted when the driver merely collects the cash', async () => {
      await deliveredCodOrder();
      expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'COD_SALE' } })).toBe(0);
    });
  });

  describe('automatic statements: amount threshold or period, whichever comes first', () => {
    async function remittedSale(): Promise<number> {
      const order = await deliveredCodOrder();
      await ctx.app.get(CodRemittedHandler).handle(remitted(order.orderId, order.grandTotal));
      return order.grandTotal - order.platformFee;
    }

    it('is editable in Module 16 configuration, and with the defaults a small fresh payable waits', async () => {
      await remittedSale();
      expect(ctx.app.get(SettlementAutoRunService).settings()).toEqual({ minAmount: 1_000_000, periodDays: 7 });
      expect((await ctx.app.get(SettlementAutoRunService).run()).generated).toEqual([]);
      expect(await ctx.prisma.settlement.count()).toBe(0);
    });

    it('the amount trigger generates a DRAFT statement once the payable reaches the threshold', async () => {
      const payable = await remittedSale();
      await setConfig('autoRunMinAmount', payable);
      const report = await ctx.app.get(SettlementAutoRunService).run();
      expect(report.generated).toEqual([expect.objectContaining({ pharmacyId: owner.pharmacyId, trigger: 'AMOUNT', netPayable: payable })]);
      const statement = await ctx.prisma.settlement.findUniqueOrThrow({ where: { id: report.generated[0].settlementId } });
      expect(statement).toMatchObject({ status: 'DRAFT', netAmount: payable });
      expect(statement.customerCashCollected).toBeGreaterThan(0);

      // Nothing new since: the next run generates nothing.
      expect((await ctx.app.get(SettlementAutoRunService).run()).generated).toEqual([]);
    });

    it('the period trigger generates one once the period has passed, even below the amount', async () => {
      await remittedSale();
      await setConfig('autoRunMinAmount', 0);
      await setConfig('autoRunPeriodDays', 7);
      const service = ctx.app.get(SettlementAutoRunService);
      expect((await service.run(new Date(Date.now() + 6 * 86_400_000))).generated).toEqual([]);
      expect((await service.run(new Date(Date.now() + 8 * 86_400_000))).generated).toEqual([
        expect.objectContaining({ pharmacyId: owner.pharmacyId, trigger: 'PERIOD' }),
      ]);
    });

    it('with both triggers off nothing is generated automatically', async () => {
      await remittedSale();
      await setConfig('autoRunMinAmount', 0);
      await setConfig('autoRunPeriodDays', 0);
      expect(await ctx.app.get(SettlementAutoRunService).run(new Date(Date.now() + 100 * 86_400_000))).toEqual({ examined: 0, generated: [], failures: 0 });
      expect(await ctx.prisma.settlement.count()).toBe(0);
    });
  });
});
