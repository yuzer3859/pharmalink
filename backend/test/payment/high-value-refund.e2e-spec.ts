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
import { ConfigOverrideLoader } from '../../src/modules/admin/infrastructure/config/config-override.loader';
import { CONFIG_PORT, IConfigPort } from '../../src/shared/config/config.port';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { createActivatedPharmacy, PharmacyOwnerContext } from '../pharmacy-inventory/support';
import { auth, body, createUserWithRole, errorOf, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Work 84: manual refunds above `approvals.highValueRefundThreshold` need a second finance officer;
 * smaller ones run at once; Module 07's own refund route cannot be used to skip the approval.
 * Collection and refunds use a fake gateway; the ledger, audit chain and outbox are real.
 */
class FakeGateway implements IPaymentProviderPort {
  readonly key = 'fake-gateway';
  refunds = 0;
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
    this.refunds += 1;
    return { outcome: 'REFUNDED', providerRef: `gw-refund-${req.refundId}` };
  }
}

const THRESHOLD = 5_000;

describe('High-value refunds (e2e)', () => {
  const gateway = new FakeGateway();
  let ctx: TestContext;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let config: IConfigPort;
  let loader: ConfigOverrideLoader;
  let owner: PharmacyOwnerContext;
  let maker: RegisteredUser & Tokens;
  let checker: RegisteredUser & Tokens;
  let admin: RegisteredUser & Tokens;
  let customer: RegisteredUser & Tokens;
  let superAdmin: string;
  let paymentId: string;
  let captured: number;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: gateway }]);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
    config = ctx.app.get(CONFIG_PORT);
    loader = ctx.app.get(ConfigOverrideLoader);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const publish = (key: string, valueType: string, value: unknown) =>
    request(ctx.server).put(`/admin/config/approvals/${key}`).set(...auth(superAdmin)).send({ valueType, value }).expect(200);

  beforeEach(async () => {
    await ctx.reset();
    await loader.refresh();
    gateway.refunds = 0;
    owner = await createActivatedPharmacy(ctx);
    maker = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    checker = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    admin = await createUserWithRole(ctx, 'ADMIN');
    customer = await createUserWithRole(ctx, 'CUSTOMER');
    superAdmin = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    await publish('highValueRefundThreshold', 'INTEGER', THRESHOLD);

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
    await ctx.prisma.fulfillment.create({
      data: { orderId: order.id, pharmacyId: owner.pharmacyId, branchId: `branch-${randomUUID()}` },
    });
    const authorized = await authorize.execute({
      customerUserId: customer.userId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    await capture.execute({ paymentId: authorized.paymentId });
    paymentId = authorized.paymentId;
    captured = (await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).amount;
  });

  const adminRefund = (token: string, payload: object, key: string | null = randomUUID()) => {
    const r = request(ctx.server).post(`/admin/finance/payments/${paymentId}/refunds`).set(...auth(token));
    return (key ? r.set('Idempotency-Key', key) : r).send(payload);
  };
  const decide = (token: string, approvalId: string, decision = 'APPROVE', reason?: string) =>
    request(ctx.server).post(`/admin/approvals/${approvalId}/decide`).set(...auth(token)).send({ decision, ...(reason ? { reason } : {}) });

  it('refuses callers without finance:refund:any (403), a missing key (400), a bad amount (400) and an unknown payment (404)', async () => {
    await adminRefund(admin.accessToken, { amount: 100 }).expect(403);
    await adminRefund(customer.accessToken, { amount: 100 }).expect(403);
    expect(errorOf(await adminRefund(maker.accessToken, { amount: 100 }, null).expect(400)).code).toBe(ErrorCode.VALIDATION_ERROR);
    await adminRefund(maker.accessToken, { amount: 0 }).expect(400);
    await request(ctx.server)
      .post(`/admin/finance/payments/${randomUUID()}/refunds`)
      .set(...auth(maker.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ amount: 100 })
      .expect(404);
    expect(await ctx.prisma.refund.count()).toBe(0);
  });

  it('runs a refund at or below the threshold at once, approved by the officer who asked', async () => {
    const res = body(await adminRefund(maker.accessToken, { amount: THRESHOLD, reason: 'Damaged item' }).expect(200));
    expect(res).toMatchObject({ outcome: 'EXECUTED', result: { amount: THRESHOLD, status: 'COMPLETED' } });
    const refund = await ctx.prisma.refund.findFirstOrThrow();
    expect(refund.approvedBy).toBe(maker.userId);
    expect(await ctx.prisma.approvalRequest.count()).toBe(0);
  });

  it('records a refund above the threshold for a second officer, who carries it out once', async () => {
    const asked = await adminRefund(maker.accessToken, { amount: THRESHOLD + 1, reason: 'Wrong order' }).expect(202);
    expect(body(asked)).toMatchObject({ outcome: 'MAKER_CHECKER_PENDING', threshold: THRESHOLD });
    const approvalId = (body(asked).approval as { id: string }).id;
    expect(await ctx.prisma.refund.count()).toBe(0);
    expect(gateway.refunds).toBe(0);

    expect(errorOf(await decide(maker.accessToken, approvalId).expect(403)).code).toBe(ErrorCode.MAKER_CHECKER_SELF_APPROVAL);
    const done = body(await decide(checker.accessToken, approvalId).expect(200));
    expect(done).toMatchObject({ status: 'APPROVED', executionResult: { amount: THRESHOLD + 1, status: 'COMPLETED' } });

    const refund = await ctx.prisma.refund.findFirstOrThrow();
    expect(refund).toMatchObject({ approvedBy: checker.userId, idempotencyKey: `approval:${approvalId}` });
    await decide(checker.accessToken, approvalId).expect(200);
    expect(await ctx.prisma.refund.count()).toBe(1);
    expect(gateway.refunds).toBe(1);
    const actions = (await ctx.prisma.auditLog.findMany({ where: { resourceId: approvalId }, orderBy: { createdAt: 'asc' } })).map((a) => [
      a.action,
      a.actorUserId,
    ]);
    expect(actions).toEqual([
      ['APPROVAL_REQUESTED', maker.userId],
      ['APPROVAL_APPROVED', checker.userId],
      ['APPROVAL_EXECUTED', checker.userId],
    ]);
  });

  it('treats an omitted amount as everything refundable when deciding', async () => {
    expect(captured).toBeGreaterThan(THRESHOLD);
    const asked = body(await adminRefund(maker.accessToken, {}).expect(202));
    expect((asked.approval as { payload: { effectiveAmount: number } }).payload.effectiveAmount).toBe(captured);
  });

  it('a rejected request refunds nothing', async () => {
    const asked = body(await adminRefund(maker.accessToken, { amount: THRESHOLD + 1 }).expect(202));
    await decide(checker.accessToken, (asked.approval as { id: string }).id, 'REJECT', 'Not eligible').expect(200);
    expect(await ctx.prisma.refund.count()).toBe(0);
    expect(gateway.refunds).toBe(0);
  });

  it('closes Module 07’s own route above the threshold (409), before writing anything', async () => {
    const direct = (amount: number) =>
      request(ctx.server)
        .post(`/payments/${paymentId}/refunds`)
        .set(...auth(maker.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ amount, reason: 'Customer complaint', destination: 'ORIGINAL' });
    const refused = await direct(THRESHOLD + 1).expect(409);
    expect(errorOf(refused).code).toBe(ErrorCode.REFUND_APPROVAL_REQUIRED);
    const omitted = await request(ctx.server)
      .post(`/payments/${paymentId}/refunds`)
      .set(...auth(maker.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Customer complaint', destination: 'ORIGINAL' })
      .expect(409);
    expect(errorOf(omitted).code).toBe(ErrorCode.REFUND_APPROVAL_REQUIRED);
    expect(await ctx.prisma.refund.count()).toBe(0);
    expect(gateway.refunds).toBe(0);

    await direct(THRESHOLD).expect(201);
    expect(await ctx.prisma.refund.count()).toBe(1);
  });

  it('switched off in approvals.makerCheckerActions, a large refund is single-actor again', async () => {
    await publish('makerCheckerActions', 'JSON', ['SETTLEMENT_APPROVE', 'SETTLEMENT_PAYOUT', 'PAYOUT_BENEFICIARY_VERIFY']);
    const res = body(await adminRefund(maker.accessToken, { amount: THRESHOLD + 1 }).expect(200));
    expect(res).toMatchObject({ outcome: 'EXECUTED', result: { amount: THRESHOLD + 1 } });
  });
});
