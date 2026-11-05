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
 * Work 83: settlement approval and payout through maker-checker, over the real HTTP stack, ledger,
 * audit chain and outbox. Collection uses a fake gateway; the payout rail is the real
 * `MockPayoutProvider` (bound outside production), whose outcome follows the account identifier:
 * `…0000` declines, `…9999` is ambiguous then confirmed by a status check, anything else pays.
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

const FIN = '/admin/finance';

describe('Settlement approval and payout (e2e)', () => {
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
    maker = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    checker = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    admin = await createUserWithRole(ctx, 'ADMIN');
    customer = await createUserWithRole(ctx, 'CUSTOMER');
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
  }

  /** A DRAFT statement for the owner's pharmacy, generated over HTTP. */
  async function draftSettlement(): Promise<{ id: string; netPayable: number }> {
    await seedCapturedOrder();
    const res = await request(ctx.server)
      .post(`${FIN}/settlements/run`)
      .set(...auth(maker.accessToken))
      .send({ pharmacyId: owner.pharmacyId, periodStart: '2020-01-01T00:00:00.000Z', periodEnd: '2030-01-01T00:00:00.000Z' })
      .expect(200);
    const s = body(res).settlement as { settlementId: string; netPayable: number };
    return { id: s.settlementId, netPayable: s.netPayable };
  }

  const post = (token: string, path: string, payload: object = {}, key: string | null = randomUUID()) => {
    const r = request(ctx.server).post(path).set(...auth(token));
    return (key ? r.set('Idempotency-Key', key) : r).send(payload);
  };
  const decide = (token: string, approvalId: string, decision = 'APPROVE') =>
    request(ctx.server).post(`/admin/approvals/${approvalId}/decide`).set(...auth(token)).send({ decision });
  const status = async (id: string) => (await ctx.prisma.settlement.findUniqueOrThrow({ where: { id } })).status;

  /** Maker asks (202), checker approves; returns the checker's response. */
  async function viaMakerChecker(path: string, expected = 200, payload: object = {}) {
    const asked = await post(maker.accessToken, path, payload).expect(202);
    expect(body(asked).outcome).toBe('MAKER_CHECKER_PENDING');
    return decide(checker.accessToken, (body(asked).approval as { id: string }).id).expect(expected);
  }

  async function approved(): Promise<{ id: string; netPayable: number }> {
    const s = await draftSettlement();
    await viaMakerChecker(`${FIN}/settlements/${s.id}/approve`);
    return s;
  }

  async function verifiedBeneficiary(accountIdentifier = '1000123456789', registrar = maker) {
    const reg = await request(ctx.server)
      .post(`${FIN}/pharmacies/${owner.pharmacyId}/payout-beneficiaries`)
      .set(...auth(registrar.accessToken))
      .send({ rail: 'BANK_TRANSFER', accountName: 'Seed Pharmacy PLC', bankCode: 'CBE', accountIdentifier })
      .expect(201);
    const id = body(reg).id as string;
    await viaMakerChecker(`${FIN}/payout-beneficiaries/${id}/verify`);
    return id;
  }

  it('refuses callers without the finance permissions (403) and a missing Idempotency-Key (400)', async () => {
    const s = await draftSettlement();
    for (const token of [admin.accessToken, customer.accessToken]) {
      await post(token, `${FIN}/settlements/${s.id}/approve`).expect(403);
      await post(token, `${FIN}/settlements/${s.id}/pay`).expect(403);
      await request(ctx.server)
        .post(`${FIN}/pharmacies/${owner.pharmacyId}/payout-beneficiaries`)
        .set(...auth(token))
        .send({ rail: 'TELEBIRR', accountName: 'X Y', accountIdentifier: '0911223344' })
        .expect(403);
    }
    expect(errorOf(await post(maker.accessToken, `${FIN}/settlements/${s.id}/approve`, {}, null).expect(400)).code).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    await post(maker.accessToken, `${FIN}/settlements/${randomUUID()}/approve`).expect(404);
  });

  it('approves only through a second officer, and approval posts nothing', async () => {
    const s = await draftSettlement();
    const ledgerBefore = await ctx.prisma.ledgerTransaction.count();
    const asked = await post(maker.accessToken, `${FIN}/settlements/${s.id}/approve`, { reason: 'Month end' }).expect(202);
    expect(await status(s.id)).toBe('DRAFT');
    const approvalId = (body(asked).approval as { id: string }).id;
    expect(errorOf(await decide(maker.accessToken, approvalId).expect(403)).code).toBe(ErrorCode.MAKER_CHECKER_SELF_APPROVAL);

    await decide(checker.accessToken, approvalId).expect(200);
    const row = await ctx.prisma.settlement.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ status: 'APPROVED', approvedByUserId: checker.userId });
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(ledgerBefore);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'SETTLEMENT_APPROVED', resourceId: s.id } })).toBe(1);
  });

  it('refuses to pay without a verified destination, before writing anything', async () => {
    const s = await approved();
    const res = await viaMakerChecker(`${FIN}/settlements/${s.id}/pay`, 422);
    expect(errorOf(res).code).toBe(ErrorCode.RESOLUTION_ACTION_FAILED);
    expect((res.body.error.details as { cause: { code: string } }).cause.code).toBe(ErrorCode.PAYOUT_BENEFICIARY_REQUIRED);
    expect(await status(s.id)).toBe('APPROVED');
    expect(await ctx.prisma.payoutAttempt.count()).toBe(0);

    // A registered but unverified destination is not one.
    await request(ctx.server)
      .post(`${FIN}/pharmacies/${owner.pharmacyId}/payout-beneficiaries`)
      .set(...auth(maker.accessToken))
      .send({ rail: 'BANK_TRANSFER', accountName: 'Seed Pharmacy PLC', bankCode: 'CBE', accountIdentifier: '1000123456789' })
      .expect(201);
    const pendingOnly = await viaMakerChecker(`${FIN}/settlements/${s.id}/pay`, 422);
    expect((pendingOnly.body.error.details as { cause: { code: string } }).cause.code).toBe(ErrorCode.PAYOUT_BENEFICIARY_REQUIRED);
    expect(await ctx.prisma.payoutAttempt.count()).toBe(0);
  });

  it('registers a destination encrypted, and only a different officer can verify it', async () => {
    const reg = await request(ctx.server)
      .post(`${FIN}/pharmacies/${owner.pharmacyId}/payout-beneficiaries`)
      .set(...auth(maker.accessToken))
      .send({ rail: 'TELEBIRR', accountName: 'Seed Pharmacy PLC', accountIdentifier: '0911 223 344' })
      .expect(201);
    const view = body(reg);
    expect(view).toMatchObject({ status: 'PENDING_VERIFICATION', accountIdentifierLast4: '3344', rail: 'TELEBIRR' });
    expect(view).not.toHaveProperty('accountIdentifierEncrypted');
    expect(JSON.stringify(view)).not.toContain('911223344');
    const row = await ctx.prisma.payoutBeneficiary.findUniqueOrThrow({ where: { id: view.id as string } });
    expect(row.accountIdentifierEncrypted).not.toContain('911223344');
    expect(
      JSON.stringify(await ctx.prisma.auditLog.findMany({ where: { resourceId: view.id as string } })),
    ).not.toContain('911223344');

    // A second pending destination for the same pharmacy is refused.
    await request(ctx.server)
      .post(`${FIN}/pharmacies/${owner.pharmacyId}/payout-beneficiaries`)
      .set(...auth(checker.accessToken))
      .send({ rail: 'TELEBIRR', accountName: 'Other', accountIdentifier: '0911000000' })
      .expect(409);

    // Even with maker-checker switched off, Module 07 refuses the registrar verifying their own.
    const superAdmin = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    await request(ctx.server)
      .put('/admin/config/approvals/makerCheckerActions')
      .set(...auth(superAdmin))
      .send({ valueType: 'JSON', value: [] })
      .expect(200);
    const self = await post(maker.accessToken, `${FIN}/payout-beneficiaries/${view.id}/verify`).expect(403);
    expect(errorOf(self).code).toBe(ErrorCode.MAKER_CHECKER_SELF_APPROVAL);
    const direct = await post(checker.accessToken, `${FIN}/payout-beneficiaries/${view.id}/verify`).expect(200);
    expect(body(direct)).toMatchObject({ outcome: 'EXECUTED', result: { status: 'VERIFIED' } });
  });

  it('pays once: PAID, one SETTLEMENT posting for the stored amount, the event, and a repeat changes nothing', async () => {
    const s = await approved();
    await verifiedBeneficiary();
    const asked = await post(maker.accessToken, `${FIN}/settlements/${s.id}/pay`).expect(202);
    const approvalId = (body(asked).approval as { id: string }).id;
    const paid = body(await decide(checker.accessToken, approvalId).expect(200));
    expect(paid).toMatchObject({ status: 'APPROVED', executionResult: { status: 'PAID', attemptStatus: 'PAID', amount: s.netPayable } });

    const row = await ctx.prisma.settlement.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.status).toBe('PAID');
    expect(row.paidAt).not.toBeNull();
    const posting = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `SETTLEMENT-${s.id}` },
      include: { entries: true },
    });
    expect(posting.type).toBe('SETTLEMENT');
    expect(posting.entries.map((e) => [e.direction, e.amount]).sort()).toEqual([
      ['CREDIT', s.netPayable],
      ['DEBIT', s.netPayable],
    ]);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'settlement.paid', aggregateId: s.id } })).toBe(1);

    await decide(checker.accessToken, approvalId).expect(200);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { reference: `SETTLEMENT-${s.id}` } })).toBe(1);
    expect(await ctx.prisma.payoutAttempt.count()).toBe(1);
    const view = body(await request(ctx.server).get(`${FIN}/settlements/${s.id}/payout`).set(...auth(maker.accessToken)).expect(200));
    expect(view).toMatchObject({ settlement: { status: 'PAID' } });
    expect(JSON.stringify(view)).not.toContain('idempotencyKey');
  });

  it('records a decline as FAILED with no posting', async () => {
    const s = await approved();
    await verifiedBeneficiary('5550000');
    const res = await viaMakerChecker(`${FIN}/settlements/${s.id}/pay`, 422);
    expect((res.body.error.details as { cause: { code: string } }).cause.code).toBe(ErrorCode.PAYOUT_DECLINED);
    expect(await status(s.id)).toBe('FAILED');
    expect(await ctx.prisma.ledgerTransaction.count({ where: { reference: `SETTLEMENT-${s.id}` } })).toBe(0);
    expect((await ctx.prisma.payoutAttempt.findFirstOrThrow()).status).toBe('FAILED');
  });

  it('leaves an ambiguous payout PROCESSING with no posting, blocks a second payout, and resolves on refresh', async () => {
    const s = await approved();
    await verifiedBeneficiary('5559999');
    const first = body(await viaMakerChecker(`${FIN}/settlements/${s.id}/pay`));
    expect(first).toMatchObject({ executionResult: { status: 'PROCESSING', attemptStatus: 'UNKNOWN' } });
    expect(await ctx.prisma.ledgerTransaction.count({ where: { reference: `SETTLEMENT-${s.id}` } })).toBe(0);

    const second = await viaMakerChecker(`${FIN}/settlements/${s.id}/pay`, 422);
    expect((second.body.error.details as { cause: { code: string } }).cause.code).toBe(ErrorCode.CONFLICT);

    const refreshed = body(
      await request(ctx.server).post(`${FIN}/settlements/${s.id}/payout/refresh`).set(...auth(checker.accessToken)).expect(200),
    );
    expect(refreshed).toMatchObject({ status: 'PAID', attempt: { status: 'PAID' } });
    expect(await ctx.prisma.ledgerTransaction.count({ where: { reference: `SETTLEMENT-${s.id}` } })).toBe(1);
  });

  it('holds a replaced destination in its cooling-off period', async () => {
    const s = await approved();
    await verifiedBeneficiary('1000111122');
    await verifiedBeneficiary('1000333344');
    const current = await ctx.prisma.payoutBeneficiary.findFirstOrThrow({ where: { status: 'VERIFIED' } });
    expect(current.payableFrom!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(await ctx.prisma.payoutBeneficiary.count({ where: { status: 'SUPERSEDED' } })).toBe(1);
    const res = await viaMakerChecker(`${FIN}/settlements/${s.id}/pay`, 422);
    expect((res.body.error.details as { cause: { code: string } }).cause.code).toBe(ErrorCode.PAYOUT_BENEFICIARY_REQUIRED);
  });

  it('turns the gated actions on by default, and runs them at once when switched off', async () => {
    const actions = body(await request(ctx.server).get('/admin/approvals/actions').set(...auth(maker.accessToken)).expect(200));
    expect(actions.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'SETTLEMENT_APPROVE', requiresApproval: true }),
        expect.objectContaining({ type: 'SETTLEMENT_PAYOUT', requiresApproval: true }),
        expect.objectContaining({ type: 'PAYOUT_BENEFICIARY_VERIFY', requiresApproval: true }),
      ]),
    );
    const s = await draftSettlement();
    const superAdmin = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    await request(ctx.server)
      .put('/admin/config/approvals/makerCheckerActions')
      .set(...auth(superAdmin))
      .send({ valueType: 'JSON', value: ['SETTLEMENT_PAYOUT'] })
      .expect(200);
    const direct = await post(maker.accessToken, `${FIN}/settlements/${s.id}/approve`).expect(200);
    expect(body(direct)).toMatchObject({ outcome: 'EXECUTED', result: { status: 'APPROVED' } });
  });
});
