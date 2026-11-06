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
 * Work 86: general disputes (module-16 §7, §9.6, §11.4, BRULE-50) over the real HTTP stack, ledger,
 * audit chain, outbox and maker-checker. Collection and refunds use a fake gateway.
 */
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

const THRESHOLD = 5_000;

describe('Disputes (e2e)', () => {
  let ctx: TestContext;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let config: IConfigPort;
  let loader: ConfigOverrideLoader;
  let owner: PharmacyOwnerContext;
  let customer: RegisteredUser & Tokens;
  let stranger: RegisteredUser & Tokens;
  let admin: RegisteredUser & Tokens;
  let finance: RegisteredUser & Tokens;
  let finance2: RegisteredUser & Tokens;
  let orderId: string;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: new FakeGateway() }]);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
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
    stranger = await createUserWithRole(ctx, 'CUSTOMER');
    admin = await createUserWithRole(ctx, 'ADMIN');
    finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    finance2 = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    const superAdmin = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    await request(ctx.server)
      .put('/admin/config/approvals/highValueRefundThreshold')
      .set(...auth(superAdmin))
      .send({ valueType: 'INTEGER', value: THRESHOLD })
      .expect(200);

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
    orderId = order.id;
  });

  const complaint = { type: 'DELIVERY', subject: 'Late delivery', description: 'The order arrived two days late and opened.' };
  const openAsCustomer = (token = customer.accessToken, payload: object = { orderId, ...complaint }) =>
    request(ctx.server).post('/disputes').set(...auth(token)).send(payload);
  const adminPatch = (token: string, id: string, payload: object) =>
    request(ctx.server).patch(`/admin/disputes/${id}`).set(...auth(token)).send(payload);
  const resolve = (token: string, id: string, payload: object) =>
    request(ctx.server).post(`/admin/disputes/${id}/resolve`).set(...auth(token)).set('Idempotency-Key', randomUUID()).send(payload);

  it('enforces who may do what (403), validates input (400), and never reveals another customer’s order (404)', async () => {
    await request(ctx.server).get('/admin/disputes').set(...auth(customer.accessToken)).expect(403);
    await request(ctx.server).get('/admin/disputes').set(...auth(admin.accessToken)).expect(200);
    await request(ctx.server).get('/admin/disputes').set(...auth(finance.accessToken)).expect(200);
    // Staff accounts are registered as customers too, so an administrator may complain about their own order.
    expect(errorOf(await openAsCustomer(customer.accessToken, { orderId, type: 'NOPE', subject: 'x', description: 'y' }).expect(400)).code).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    await openAsCustomer(stranger.accessToken).expect(404);
    expect(await ctx.prisma.disputeCase.count()).toBe(0);
  });

  it('opens one case per order and topic, with a case number, an SLA and an audit entry', async () => {
    const opened = body(await openAsCustomer().expect(201));
    expect(opened).toMatchObject({ status: 'OPEN', priority: 'NORMAL', type: 'DELIVERY', orderId, overdue: false });
    expect(opened.caseNumber).toMatch(/^DSP-\d{8}-[0-9A-F]{6}$/);
    expect(new Date(opened.slaDueAt as string).getTime() - new Date(opened.openedAt as string).getTime()).toBe(72 * 3600_000);
    expect(opened).not.toHaveProperty('complainantUserId');
    expect(errorOf(await openAsCustomer().expect(409)).code).toBe(ErrorCode.CONFLICT);
    await openAsCustomer(customer.accessToken, { orderId, ...complaint, type: 'PAYMENT' }).expect(201);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'DISPUTE_OPENED' } })).toBe(2);
    const mine = body(await request(ctx.server).get('/disputes').set(...auth(customer.accessToken)).expect(200));
    expect(mine.total).toBe(2);
    expect(body(await request(ctx.server).get('/disputes').set(...auth(stranger.accessToken)).expect(200)).total).toBe(0);
  });

  it('keeps internal notes from the customer and tells them about replies', async () => {
    const id = body(await openAsCustomer().expect(201)).id as string;
    const post = (token: string, path: string, payload: object) => request(ctx.server).post(path).set(...auth(token)).send(payload);
    await post(admin.accessToken, `/admin/disputes/${id}/messages`, { body: 'Driver logs show a 2-day delay.', internal: true }).expect(201);
    await post(admin.accessToken, `/admin/disputes/${id}/messages`, { body: 'We are looking into it.' }).expect(201);
    await post(customer.accessToken, `/disputes/${id}/messages`, { body: 'Thank you.' }).expect(201);
    await post(stranger.accessToken, `/disputes/${id}/messages`, { body: 'Hi' }).expect(404);

    const seen = body(await request(ctx.server).get(`/disputes/${id}`).set(...auth(customer.accessToken)).expect(200));
    expect((seen.messages as Array<{ body: string }>).map((m) => m.body)).toEqual(['We are looking into it.', 'Thank you.']);
    expect(JSON.stringify(seen)).not.toContain('Driver logs');
    const full = body(await request(ctx.server).get(`/admin/disputes/${id}`).set(...auth(admin.accessToken)).expect(200));
    expect(full.messages).toHaveLength(3);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'admin.dispute.updated' } })).toBe(1);
  });

  it('moves through working states, recomputes the SLA on a priority change, and refuses illegal moves (409)', async () => {
    const id = body(await openAsCustomer().expect(201)).id as string;
    expect(errorOf(await adminPatch(admin.accessToken, id, { status: 'CLOSED' }).expect(409)).code).toBe(
      ErrorCode.INVALID_DISPUTE_STATE_TRANSITION,
    );
    const working = body(await adminPatch(admin.accessToken, id, { status: 'INVESTIGATING', assignToMe: true, priority: 'URGENT' }).expect(200));
    expect(working).toMatchObject({ status: 'INVESTIGATING', priority: 'URGENT', assignedAdminId: admin.userId });
    expect(new Date(working.slaDueAt as string).getTime() - new Date(working.openedAt as string).getTime()).toBe(4 * 3600_000);
    await adminPatch(admin.accessToken, id, { status: 'ESCALATED', reason: 'Repeat issue' }).expect(200);
    await adminPatch(admin.accessToken, id, { status: 'RESOLVED' }).expect(409);

    await ctx.prisma.disputeCase.update({ where: { id }, data: { slaDueAt: new Date(Date.now() - 1000) } });
    const overdue = body(await request(ctx.server).get('/admin/disputes?overdue=true').set(...auth(admin.accessToken)).expect(200));
    expect(overdue.total).toBe(1);
  });

  it('resolves with no action, shows the customer only the remedy, then closes', async () => {
    const id = body(await openAsCustomer().expect(201)).id as string;
    const done = body(await resolve(admin.accessToken, id, { action: 'NO_ACTION', notes: 'Delivered within the promised window.' }).expect(200));
    expect(done).toMatchObject({ status: 'RESOLVED', resolution: { action: 'NO_ACTION', resolvedBy: admin.userId } });
    const seen = body(await request(ctx.server).get(`/disputes/${id}`).set(...auth(customer.accessToken)).expect(200));
    expect(seen.resolution).toEqual({ action: 'NO_ACTION' });
    await resolve(admin.accessToken, id, { action: 'NO_ACTION', notes: 'Again' }).expect(409);
    await adminPatch(admin.accessToken, id, { status: 'CLOSED' }).expect(200);
    await request(ctx.server).post(`/disputes/${id}/messages`).set(...auth(customer.accessToken)).send({ body: 'More' }).expect(409);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'DISPUTE_RESOLVED', resourceId: id } })).toBe(1);
  });

  it('resolves with a refund through the owning module: small at once, and only by someone who may refund', async () => {
    const id = body(await openAsCustomer().expect(201)).id as string;
    await resolve(admin.accessToken, id, { action: 'REFUND', notes: 'Partial refund for the delay', amount: 1_000 }).expect(403);
    const done = body(await resolve(finance.accessToken, id, { action: 'REFUND', notes: 'Partial refund for the delay', amount: 1_000 }).expect(200));
    expect(done).toMatchObject({ status: 'RESOLVED', resolution: { action: 'REFUND', refund: { amount: 1_000, status: 'COMPLETED' } } });
    expect(await ctx.prisma.refund.count()).toBe(1);
  });

  it('a high-value refund waits for a second finance officer, and the case completes when it is carried out', async () => {
    const id = body(await openAsCustomer().expect(201)).id as string;
    const pending = body(await resolve(finance.accessToken, id, { action: 'REFUND', notes: 'Full refund', amount: THRESHOLD + 1 }).expect(200));
    expect(pending).toMatchObject({ status: 'RESOLUTION_PENDING' });
    expect(await ctx.prisma.refund.count()).toBe(0);
    await resolve(finance2.accessToken, id, { action: 'NO_ACTION', notes: 'Overrule' }).expect(409);

    await request(ctx.server)
      .post(`/admin/approvals/${pending.pendingApprovalId as string}/decide`)
      .set(...auth(finance2.accessToken))
      .send({ decision: 'APPROVE' })
      .expect(200);
    const after = body(await request(ctx.server).get(`/admin/disputes/${id}`).set(...auth(admin.accessToken)).expect(200));
    expect(after).toMatchObject({ status: 'RESOLVED', pendingApprovalId: null, resolution: { action: 'REFUND', approvalId: pending.pendingApprovalId } });
    expect((await ctx.prisma.refund.findFirstOrThrow()).approvedBy).toBe(finance2.userId);
  });
});
