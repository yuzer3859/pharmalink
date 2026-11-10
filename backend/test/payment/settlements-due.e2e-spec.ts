import { randomUUID } from 'crypto';
import request from 'supertest';
import { AuthorizePaymentCommand } from '../../src/modules/payment/application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../src/modules/payment/application/commands/capture-payment.command';
import {
  IPaymentProviderPort,
  PAYMENT_PROVIDER_PORT,
  ProviderAuthorizationRequest,
  ProviderAuthorizationResult,
  ProviderCaptureResult,
  ProviderPaymentOperationRequest,
  ProviderRefundRequest,
  ProviderRefundResult,
  ProviderVoidResult,
} from '../../src/modules/payment/application/ports/outbound/payment-provider.port';
import { PaymentMethod } from '../../src/modules/payment/domain/enums';
import { PricingCalculator } from '../../src/modules/orders/domain/services/pricing-calculator';
import { CONFIG_PORT, IConfigPort } from '../../src/shared/config/config.port';
import { createActivatedPharmacy, PharmacyOwnerContext } from '../pharmacy-inventory/support';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

class FakeGateway implements IPaymentProviderPort {
  readonly key = 'fake-gateway';
  supports(method: PaymentMethod): boolean {
    return method !== PaymentMethod.COD && method !== PaymentMethod.WALLET;
  }
  async authorize(req: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    return { outcome: 'AUTHORIZED', providerRef: `gw-auth-${req.paymentId}` };
  }
  async capture(req: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    return { outcome: 'CAPTURED', providerRef: `gw-capture-${req.paymentId}` };
  }
  async voidAuthorization(req: ProviderPaymentOperationRequest): Promise<ProviderVoidResult> {
    return { outcome: 'VOIDED', providerRef: `gw-void-${req.paymentId}` };
  }
  async refund(req: ProviderRefundRequest): Promise<ProviderRefundResult> {
    return { outcome: 'REFUNDED', providerRef: `gw-refund-${req.refundId}` };
  }
}

interface Due {
  pharmacyId: string;
  pharmacyName: string | null;
  currency: string;
  periodStart: string;
  periodEnd: string;
  netPayable: number;
  lineCount: number;
  lastStatement: { settlementId: string; status: string } | null;
  autoRunTrigger: string | null;
}

const FIN = '/admin/finance';

/**
 * Work 124: `GET /admin/finance/settlements/due`, what a finance officer can settle now, and that a
 * run over the period it reports produces the figure it showed.
 */
describe('Settlements due (Work 124, e2e)', () => {
  let ctx: TestContext;
  let config: IConfigPort;
  let owner: PharmacyOwnerContext;
  let finance: RegisteredUser & Tokens;
  let customer: RegisteredUser & Tokens;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: new FakeGateway() }]);
    config = ctx.app.get(CONFIG_PORT);
    await ctx.reset();
    owner = await createActivatedPharmacy(ctx);
    finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    customer = await createUserWithRole(ctx, 'CUSTOMER');
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function seedCapturedOrder(): Promise<void> {
    const totals = PricingCalculator.computeTotals({
      lines: [{ unitPrice: 9_000, quantity: 1 }],
      deliveryFee: 1_000,
      platformFeePercent: config.get<number>('orders.platformFeePercent') ?? 0,
      discountTotal: 0,
    });
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: customer.userId,
        status: 'PENDING_PAYMENT',
        subtotal: totals.subtotal,
        deliveryFee: totals.deliveryFee,
        platformFee: totals.platformFee,
        discountTotal: totals.discountTotal,
        grandTotal: totals.grandTotal,
        currency: totals.currency,
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: false,
      },
    });
    await ctx.prisma.fulfillment.create({ data: { orderId: order.id, pharmacyId: owner.pharmacyId, branchId: `branch-${randomUUID()}` } });
    const authorized = await ctx.app.get(AuthorizePaymentCommand).execute({
      customerUserId: customer.userId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    await ctx.app.get(CapturePaymentCommand).execute({ paymentId: authorized.paymentId });
  }

  const due = async () => body(await request(ctx.server).get(`${FIN}/settlements/due`).set(...auth(finance.accessToken)).expect(200)) as unknown as { items: Due[] };

  it('lists nothing when nothing is owed', async () => {
    expect((await due()).items).toEqual([]);
  });

  it('lists a pharmacy with an unsettled payable, by name, with the period and figure a run produces', async () => {
    await seedCapturedOrder();
    const [row] = (await due()).items;
    expect(row).toMatchObject({ pharmacyId: owner.pharmacyId, pharmacyName: 'Test Pharmacy', currency: 'ETB', lineCount: 1, lastStatement: null });
    expect(row.netPayable).toBeGreaterThan(0);
    expect(row.periodStart).toBe('2020-01-01T00:00:00.000Z');

    const run = body(
      await request(ctx.server)
        .post(`${FIN}/settlements/run`)
        .set(...auth(finance.accessToken))
        .send({ pharmacyId: row.pharmacyId, periodStart: row.periodStart, periodEnd: new Date().toISOString(), currency: row.currency })
        .expect(200),
    ).settlement as { netPayable: number; status: string };
    expect(run).toMatchObject({ netPayable: row.netPayable, status: 'DRAFT' });
  });

  it('once settled, the pharmacy is no longer due until it is owed again', async () => {
    expect((await due()).items).toEqual([]);
    await seedCapturedOrder();
    const [row] = (await due()).items;
    expect(row.lastStatement).toMatchObject({ status: 'DRAFT' });
    expect(row.lineCount).toBe(1);
  });

  it('needs finance:settlement:any: a finance officer, not a customer or an operations admin', async () => {
    await request(ctx.server).get(`${FIN}/settlements/due`).set(...auth(customer.accessToken)).expect(403);
    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server).get(`${FIN}/settlements/due`).set(...auth(admin.accessToken)).expect(403);
  });
});
