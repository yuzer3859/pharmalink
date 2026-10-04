import { randomUUID } from 'crypto';
import request from 'supertest';
import { ApplyCouponCommand } from '../../src/modules/payment/application/commands/apply-coupon.command';
import { ReverseCouponCommand } from '../../src/modules/payment/application/commands/reverse-coupon.command';
import {
  COUPON_PORT,
  ICouponPort,
} from '../../src/modules/payment/application/ports/inbound/coupon.port';
import { ApiException } from '../../src/shared/errors/api-exception';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Coupons against real PostgreSQL (§3.4, §5.1, §7, §9.5, F-CPN-01..03).
 *
 * Nothing is substituted: real `AppModule` wiring, real commands, real Prisma repositories, real
 * `Serializable` transactions, the real global guards and `ValidationPipe`, real Module 03 catalog
 * rows and real Module 06 cart/order rows. That matters most for the usage limits — "two
 * concurrent applications cannot both take the last remaining usage" is enforced by PostgreSQL's
 * serializable snapshot isolation, and a test against an in-memory double could not observe
 * whether it actually holds.
 *
 * Module 06 is untouched: its cart and order rows are seeded directly, exactly as the payment and
 * wallet suites already do, because its Slice-1 checkout is COD-only and this task does not wire
 * coupons into it.
 */
describe('Coupons (e2e)', () => {
  let ctx: TestContext;
  let admin: RegisteredUser & Tokens;
  let applyCoupon: ApplyCouponCommand;
  let reverseCoupon: ReverseCouponCommand;
  let couponPort: ICouponPort;

  beforeAll(async () => {
    ctx = await createTestApp();
    applyCoupon = ctx.app.get(ApplyCouponCommand);
    reverseCoupon = ctx.app.get(ReverseCouponCommand);
    couponPort = ctx.app.get(COUPON_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — real Module 03 catalog rows, real Module 06 cart/order rows.
  // -------------------------------------------------------------------------------------------

  async function seedProduct(options: { price: number; categoryId?: string }) {
    const product = await ctx.prisma.product.create({
      data: {
        type: 'MEDICINE',
        genericName: `Product ${randomUUID()}`,
        status: 'ACTIVE',
        price: options.price,
      },
    });
    if (options.categoryId) {
      await ctx.prisma.productCategory.create({
        data: { productId: product.id, categoryId: options.categoryId },
      });
    }
    return product;
  }

  async function seedCategory() {
    return ctx.prisma.category.create({
      data: { slug: `category-${randomUUID()}`, nameEn: 'Test category' },
    });
  }

  async function seedCart(
    customerUserId: string,
    lines: Array<{ productId: string; quantity: number }>,
  ) {
    const cart = await ctx.prisma.cart.create({ data: { customerUserId, status: 'ACTIVE' } });
    for (const line of lines) {
      await ctx.prisma.cartItem.create({
        data: {
          cartId: cart.id,
          catalogProductId: line.productId,
          quantity: line.quantity,
          // Deliberately wrong: the coupon must price from Module 03, never from this cache.
          indicativePrice: 999_999,
        },
      });
    }
    return cart;
  }

  async function seedOrder(
    customerUserId: string,
    lines: Array<{ productId: string; unitPrice: number; quantity: number; pharmacyId?: string }>,
  ) {
    const subtotal = lines.reduce((total, l) => total + l.unitPrice * l.quantity, 0);
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId,
        status: 'PENDING_PAYMENT',
        subtotal,
        deliveryFee: 0,
        platformFee: 0,
        discountTotal: 0,
        grandTotal: subtotal,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: false,
      },
    });
    for (const line of lines) {
      await ctx.prisma.orderLine.create({
        data: {
          orderId: order.id,
          catalogProductId: line.productId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.unitPrice * line.quantity,
          pharmacyId: line.pharmacyId ?? `pharmacy-${randomUUID()}`,
        },
      });
    }
    return order;
  }

  function createCoupon(payload: Record<string, unknown>, token = admin.accessToken) {
    return request(ctx.server)
      .post('/admin/finance/coupons')
      .set(...auth(token))
      .send(payload);
  }

  function validate(token: string, payload: Record<string, unknown>) {
    return request(ctx.server)
      .post('/coupons/validate')
      .set(...auth(token))
      .send(payload);
  }

  // ===========================================================================================
  // Admin CRUD (§9.5, F-CPN-01)
  // ===========================================================================================

  it('creates a coupon, canonicalizing its code', async () => {
    const data = body(
      await createCoupon({
        code: '  save10 ',
        discountType: 'PERCENT',
        value: 10,
        minSpend: 500,
        usageLimitGlobal: 100,
        usageLimitPerUser: 1,
      }).expect(201),
    );

    expect(data).toMatchObject({
      code: 'SAVE10',
      discountType: 'PERCENT',
      value: 10,
      minSpend: 500,
      usageLimitGlobal: 100,
      usageLimitPerUser: 1,
      isActive: true,
    });

    const row = await ctx.prisma.coupon.findUniqueOrThrow({ where: { code: 'SAVE10' } });
    expect(row.value).toBe(10);
    // No usage counter column exists, and none was invented.
    expect(Object.keys(row)).not.toContain('usageCount');
    expect(Object.keys(row)).not.toContain('timesRedeemed');
  });

  it('refuses a duplicate code in any case', async () => {
    await createCoupon({ code: 'SAVE10', discountType: 'PERCENT', value: 10 }).expect(201);

    const response = await createCoupon({
      code: 'save10',
      discountType: 'PERCENT',
      value: 20,
    }).expect(409);

    expect(response.body.error.code).toBe(ErrorCode.CONFLICT);
    expect(await ctx.prisma.coupon.count()).toBe(1);
  });

  it.each([
    ['a percentage over 100', { discountType: 'PERCENT', value: 101 }],
    ['a zero value', { discountType: 'PERCENT', value: 0 }],
    ['a negative value', { discountType: 'FIXED', value: -100 }],
    ['a zero maxDiscount', { discountType: 'PERCENT', value: 10, maxDiscount: 0 }],
    ['a zero usage limit', { discountType: 'PERCENT', value: 10, usageLimitGlobal: 0 }],
    ['an unknown discount type', { discountType: 'BOGO', value: 10 }],
    ['an unknown scope dimension', { discountType: 'PERCENT', value: 10, scope: { brandIds: ['x'] } }],
    ['an empty scope list', { discountType: 'PERCENT', value: 10, scope: { productIds: [] } }],
  ])('rejects %s', async (_label, payload) => {
    await createCoupon({ code: `C${randomUUID().slice(0, 8)}`, ...payload }).expect(400);
    expect(await ctx.prisma.coupon.count()).toBe(0);
  });

  it('rejects an inverted validity window', async () => {
    await createCoupon({
      code: 'WINDOW',
      discountType: 'PERCENT',
      value: 10,
      startsAt: '2026-06-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:00:00.000Z',
    }).expect(400);
    expect(await ctx.prisma.coupon.count()).toBe(0);
  });

  it.each(['id', 'createdAt', 'timesRedeemed', 'usageCount', 'userId'])(
    'refuses a client-supplied %s field outright',
    async (field) => {
      await createCoupon({
        code: 'SAVE10',
        discountType: 'PERCENT',
        value: 10,
        [field]: 'attacker-value',
      }).expect(400);
      expect(await ctx.prisma.coupon.count()).toBe(0);
    },
  );

  it('updates a coupon without letting its code change', async () => {
    const created = body(
      await createCoupon({ code: 'SAVE10', discountType: 'PERCENT', value: 10 }).expect(201),
    );

    const updated = body(
      await request(ctx.server)
        .patch(`/admin/finance/coupons/${created.id as string}`)
        .set(...auth(admin.accessToken))
        .send({ value: 25, maxDiscount: 500 })
        .expect(200),
    );
    expect(updated).toMatchObject({ code: 'SAVE10', value: 25, maxDiscount: 500 });

    // `code` is not part of the update contract at all.
    await request(ctx.server)
      .patch(`/admin/finance/coupons/${created.id as string}`)
      .set(...auth(admin.accessToken))
      .send({ code: 'DIFFERENT' })
      .expect(400);
    await expect(
      ctx.prisma.coupon.findUniqueOrThrow({ where: { id: created.id as string } }),
    ).resolves.toMatchObject({ code: 'SAVE10' });
  });

  it('deactivates and reactivates a coupon', async () => {
    const created = body(
      await createCoupon({ code: 'SAVE10', discountType: 'PERCENT', value: 10 }).expect(201),
    );
    const url = `/admin/finance/coupons/${created.id as string}/status`;

    expect(
      body(
        await request(ctx.server)
          .post(url)
          .set(...auth(admin.accessToken))
          .send({ isActive: false })
          .expect(200),
      ).isActive,
    ).toBe(false);
    expect(
      body(
        await request(ctx.server)
          .post(url)
          .set(...auth(admin.accessToken))
          .send({ isActive: true })
          .expect(200),
      ).isActive,
    ).toBe(true);
  });

  it('lists and reads coupons with their derived usage', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const created = body(
      await createCoupon({ code: 'SAVE10', discountType: 'PERCENT', value: 10 }).expect(201),
    );
    const product = await seedProduct({ price: 1_000 });
    const order = await seedOrder(customer.userId, [
      { productId: product.id, unitPrice: 1_000, quantity: 1 },
    ]);
    await applyCoupon.execute({
      code: 'SAVE10',
      orderId: order.id,
      customerUserId: customer.userId,
    });

    const one = body(
      await request(ctx.server)
        .get(`/admin/finance/coupons/${created.id as string}`)
        .set(...auth(admin.accessToken))
        .expect(200),
    );
    const list = body(
      await request(ctx.server)
        .get('/admin/finance/coupons?isActive=true&page=1&size=10')
        .set(...auth(admin.accessToken))
        .expect(200),
    );

    // Counted from APPLIED rows, not read from a column.
    expect(one.timesRedeemed).toBe(1);
    expect(list).toMatchObject({ total: 1, page: 1, size: 10 });
    expect((list.items as Array<Record<string, unknown>>)[0].timesRedeemed).toBe(1);
  });

  it('exposes the redemptions behind a coupon’s usage figure', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const created = body(
      await createCoupon({ code: 'SAVE10', discountType: 'PERCENT', value: 10 }).expect(201),
    );
    const product = await seedProduct({ price: 1_000 });
    const order = await seedOrder(customer.userId, [
      { productId: product.id, unitPrice: 1_000, quantity: 1 },
    ]);
    await applyCoupon.execute({
      code: 'SAVE10',
      orderId: order.id,
      customerUserId: customer.userId,
    });

    const rows = body(
      await request(ctx.server)
        .get(`/admin/finance/coupons/${created.id as string}/redemptions`)
        .set(...auth(admin.accessToken))
        .expect(200),
    ) as unknown as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orderId: order.id,
      userId: customer.userId,
      discountAmount: 100,
      status: 'APPLIED',
    });
  });

  it('refuses admin CRUD to a customer, and to a finance officer', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');

    for (const token of [customer.accessToken, finance.accessToken]) {
      await createCoupon({ code: 'SAVE10', discountType: 'PERCENT', value: 10 }, token).expect(
        403,
      );
      await request(ctx.server)
        .get('/admin/finance/coupons')
        .set(...auth(token))
        .expect(403);
    }
    expect(await ctx.prisma.coupon.count()).toBe(0);
  });

  it('requires authentication on the admin routes', async () => {
    await request(ctx.server)
      .post('/admin/finance/coupons')
      .send({ code: 'SAVE10', discountType: 'PERCENT', value: 10 })
      .expect(401);
  });

  it('records coupon curation in the hash-chained audit log, and publishes nothing', async () => {
    const created = body(
      await createCoupon({ code: 'SAVE10', discountType: 'PERCENT', value: 10 }).expect(201),
    );
    await request(ctx.server)
      .post(`/admin/finance/coupons/${created.id as string}/status`)
      .set(...auth(admin.accessToken))
      .send({ isActive: false })
      .expect(200);

    const audits = await ctx.prisma.auditLog.findMany({
      where: { resourceType: 'Coupon' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['COUPON_CREATED', 'COUPON_DEACTIVATED']);
    expect(audits[0].actorUserId).toBe(admin.userId);
    expect(audits[0].context).toMatchObject({ code: 'SAVE10', outcome: 'OK' });

    // Curation is audited, never published — no coupon.created/updated event is catalogued.
    expect(await ctx.prisma.outbox.count({ where: { aggregateType: 'Coupon' } })).toBe(0);
  });

  // ===========================================================================================
  // Validation (§9.5)
  // ===========================================================================================

  it('quotes a discount against the caller’s real cart, at real catalog prices', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({ code: 'SAVE10', discountType: 'PERCENT', value: 10 }).expect(201);
    const product = await seedProduct({ price: 500 });
    await seedCart(customer.userId, [{ productId: product.id, quantity: 2 }]);

    const data = body(
      await validate(customer.accessToken, { code: 'save10', cartTotal: 1_000 }).expect(200),
    );

    expect(data).toMatchObject({
      valid: true,
      discountAmount: 100,
      code: 'SAVE10',
      cartSubtotal: 1_000,
      eligibleSubtotal: 1_000,
      cartTotalMismatch: false,
    });
    // `indicativePrice` was seeded as 999999 and was correctly ignored.
    expect(data.cartSubtotal).toBe(1_000);
  });

  it('creates no redemption row and writes no audit or event', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({ code: 'SAVE10', discountType: 'PERCENT', value: 10 }).expect(201);
    const product = await seedProduct({ price: 1_000 });
    await seedCart(customer.userId, [{ productId: product.id, quantity: 1 }]);
    const auditsBefore = await ctx.prisma.auditLog.count();

    await validate(customer.accessToken, { code: 'SAVE10' }).expect(200);

    expect(await ctx.prisma.couponRedemption.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count()).toBe(auditsBefore);
    expect(await ctx.prisma.outbox.count({ where: { aggregateType: 'Coupon' } })).toBe(0);
  });

  it('ignores a client-supplied cartTotal and items, and flags the disagreement', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({ code: 'SAVE10', discountType: 'PERCENT', value: 10 }).expect(201);
    const cheap = await seedProduct({ price: 100 });
    const expensive = await seedProduct({ price: 100_000 });
    await seedCart(customer.userId, [{ productId: cheap.id, quantity: 1 }]);

    const data = body(
      await validate(customer.accessToken, {
        code: 'SAVE10',
        cartTotal: 100_000,
        // A product the customer does not have in their cart.
        items: [{ productId: expensive.id, quantity: 1 }],
      }).expect(200),
    );

    // 10% of the server's 100, not of the 100000 the client asserted.
    expect(data).toMatchObject({
      discountAmount: 10,
      cartSubtotal: 100,
      cartTotalMismatch: true,
    });
  });

  it.each(['userId', 'customerUserId', 'discountAmount', 'valid'])(
    'refuses a client-supplied %s on validation',
    async (field) => {
      const customer = await createUserWithRole(ctx, 'CUSTOMER');
      await validate(customer.accessToken, { code: 'SAVE10', [field]: 'x' }).expect(400);
    },
  );

  it('answers valid:false rather than an error when the coupon does not apply', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({
      code: 'BIGSPEND',
      discountType: 'PERCENT',
      value: 10,
      minSpend: 50_000,
    }).expect(201);
    const product = await seedProduct({ price: 1_000 });
    await seedCart(customer.userId, [{ productId: product.id, quantity: 1 }]);

    const data = body(await validate(customer.accessToken, { code: 'BIGSPEND' }).expect(200));

    expect(data).toMatchObject({ valid: false, reason: 'MIN_SPEND_NOT_MET', discountAmount: 0 });
  });

  it('answers an unknown code without revealing whether it exists', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({
      code: 'HIDDEN',
      discountType: 'PERCENT',
      value: 10,
      isActive: false,
    }).expect(201);

    const unknown = body(await validate(customer.accessToken, { code: 'NOTACODE' }).expect(200));
    const inactive = body(await validate(customer.accessToken, { code: 'HIDDEN' }).expect(200));

    expect(unknown.valid).toBe(false);
    expect(inactive.valid).toBe(false);
    // Neither response carries the coupon's configuration.
    for (const response of [unknown, inactive]) {
      expect(response).not.toHaveProperty('usageLimitGlobal');
      expect(response).not.toHaveProperty('scope');
      expect(response).not.toHaveProperty('minSpend');
    }
  });

  it('scores a category scope through Module 03’s own product/category join', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const vitamins = await seedCategory();
    const other = await seedCategory();
    const inScope = await seedProduct({ price: 500, categoryId: vitamins.id });
    const outOfScope = await seedProduct({ price: 500, categoryId: other.id });
    await createCoupon({
      code: 'VITAMINS',
      discountType: 'PERCENT',
      value: 10,
      scope: { categoryIds: [vitamins.id] },
    }).expect(201);
    await seedCart(customer.userId, [
      { productId: inScope.id, quantity: 1 },
      { productId: outOfScope.id, quantity: 1 },
    ]);

    const data = body(await validate(customer.accessToken, { code: 'VITAMINS' }).expect(200));

    // 10% of the 500 in scope, not of the 1000 in the cart.
    expect(data).toMatchObject({ valid: true, discountAmount: 50, eligibleSubtotal: 500 });
    expect(data.cartSubtotal).toBe(1_000);
  });

  it('scores a product scope against only that product', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const a = await seedProduct({ price: 500 });
    const b = await seedProduct({ price: 500 });
    await createCoupon({
      code: 'ONLYA',
      discountType: 'PERCENT',
      value: 10,
      scope: { productIds: [a.id] },
    }).expect(201);
    await seedCart(customer.userId, [
      { productId: a.id, quantity: 1 },
      { productId: b.id, quantity: 1 },
    ]);

    expect(body(await validate(customer.accessToken, { code: 'ONLYA' }).expect(200))).toMatchObject(
      { discountAmount: 50, eligibleSubtotal: 500 },
    );
  });

  it('refuses a pharmacy-scoped coupon against a cart, because a cart has no pharmacy', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({
      code: 'PHARMA',
      discountType: 'PERCENT',
      value: 10,
      scope: { pharmacyIds: [`pharmacy-${randomUUID()}`] },
    }).expect(201);
    const product = await seedProduct({ price: 1_000 });
    await seedCart(customer.userId, [{ productId: product.id, quantity: 1 }]);

    const data = body(await validate(customer.accessToken, { code: 'PHARMA' }).expect(200));

    // Honest rather than guessed: a cart line has no pharmacy until checkout assigns one.
    expect(data).toMatchObject({
      valid: false,
      reason: 'PHARMACY_SCOPE_UNRESOLVABLE',
      discountAmount: 0,
    });
  });

  it('caps a percentage discount at maxDiscount', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({
      code: 'CAPPED',
      discountType: 'PERCENT',
      value: 10,
      maxDiscount: 75,
    }).expect(201);
    const product = await seedProduct({ price: 5_000 });
    await seedCart(customer.userId, [{ productId: product.id, quantity: 1 }]);

    expect(
      body(await validate(customer.accessToken, { code: 'CAPPED' }).expect(200)).discountAmount,
    ).toBe(75);
  });

  it('never discounts more than the eligible subtotal', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({ code: 'BIGFIXED', discountType: 'FIXED', value: 5_000 }).expect(201);
    const product = await seedProduct({ price: 1_000 });
    await seedCart(customer.userId, [{ productId: product.id, quantity: 1 }]);

    expect(
      body(await validate(customer.accessToken, { code: 'BIGFIXED' }).expect(200)),
    ).toMatchObject({ valid: true, discountAmount: 1_000 });
  });

  // ===========================================================================================
  // Apply / reverse (F-CPN-02, F-CPN-03)
  // ===========================================================================================

  async function couponAndOrder(options: {
    code: string;
    coupon?: Record<string, unknown>;
    price?: number;
    pharmacyId?: string;
  }) {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({
      code: options.code,
      discountType: 'PERCENT',
      value: 10,
      ...(options.coupon ?? {}),
    }).expect(201);
    const product = await seedProduct({ price: options.price ?? 1_000 });
    const order = await seedOrder(customer.userId, [
      {
        productId: product.id,
        unitPrice: options.price ?? 1_000,
        quantity: 1,
        pharmacyId: options.pharmacyId,
      },
    ]);
    return { customer, order, product };
  }

  it('persists a redemption when a coupon is applied to an order', async () => {
    const { customer, order } = await couponAndOrder({ code: 'SAVE10' });

    const result = await applyCoupon.execute({
      code: 'SAVE10',
      orderId: order.id,
      customerUserId: customer.userId,
    });

    expect(result).toMatchObject({
      orderId: order.id,
      customerUserId: customer.userId,
      discountAmount: 100,
      status: 'APPLIED',
      replay: false,
    });
    const row = await ctx.prisma.couponRedemption.findUniqueOrThrow({
      where: { id: result.redemptionId },
    });
    expect(row).toMatchObject({
      orderId: order.id,
      userId: customer.userId,
      discountAmount: 100,
      status: 'APPLIED',
    });
  });

  it('replays an application instead of counting a second usage', async () => {
    const { customer, order } = await couponAndOrder({
      code: 'SAVE10',
      coupon: { usageLimitGlobal: 1 },
    });
    const req = { code: 'SAVE10', orderId: order.id, customerUserId: customer.userId };
    const first = await applyCoupon.execute(req);

    const second = await applyCoupon.execute(req);

    expect(second.replay).toBe(true);
    expect(second.redemptionId).toBe(first.redemptionId);
    expect(await ctx.prisma.couponRedemption.count()).toBe(1);
  });

  it('collapses two concurrent applications to the same order into one redemption', async () => {
    const { customer, order } = await couponAndOrder({ code: 'SAVE10' });
    const req = { code: 'SAVE10', orderId: order.id, customerUserId: customer.userId };

    const results = await Promise.allSettled([
      applyCoupon.execute(req),
      applyCoupon.execute(req),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await ctx.prisma.couponRedemption.count()).toBe(1);
  });

  /**
   * §11 of the task brief, against real PostgreSQL. A global limit of 1, two simultaneous
   * applications to *different* orders. Exactly one may commit; the loser either counts the
   * winner's row and refuses, or is aborted by SSI and refuses after `runWithPaymentRetry`
   * re-runs it. What is never acceptable is two redemptions against a limit of one.
   */
  it('lets exactly one of two concurrent applications take the last global usage', async () => {
    const customerA = await createUserWithRole(ctx, 'CUSTOMER');
    const customerB = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({
      code: 'LASTONE',
      discountType: 'PERCENT',
      value: 10,
      usageLimitGlobal: 1,
    }).expect(201);
    const product = await seedProduct({ price: 1_000 });
    const orderA = await seedOrder(customerA.userId, [
      { productId: product.id, unitPrice: 1_000, quantity: 1 },
    ]);
    const orderB = await seedOrder(customerB.userId, [
      { productId: product.id, unitPrice: 1_000, quantity: 1 },
    ]);

    const results = await Promise.allSettled([
      applyCoupon.execute({
        code: 'LASTONE',
        orderId: orderA.id,
        customerUserId: customerA.userId,
      }),
      applyCoupon.execute({
        code: 'LASTONE',
        orderId: orderB.id,
        customerUserId: customerB.userId,
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as ApiException).code).toBe(ErrorCode.COUPON_USAGE_EXCEEDED);
    expect(
      await ctx.prisma.couponRedemption.count({ where: { status: 'APPLIED' } }),
    ).toBe(1);
  });

  it('lets exactly one of two concurrent applications take the last per-user usage', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await createCoupon({
      code: 'ONEPERUSER',
      discountType: 'PERCENT',
      value: 10,
      usageLimitPerUser: 1,
    }).expect(201);
    const product = await seedProduct({ price: 1_000 });
    const orderA = await seedOrder(customer.userId, [
      { productId: product.id, unitPrice: 1_000, quantity: 1 },
    ]);
    const orderB = await seedOrder(customer.userId, [
      { productId: product.id, unitPrice: 1_000, quantity: 1 },
    ]);

    const results = await Promise.allSettled([
      applyCoupon.execute({
        code: 'ONEPERUSER',
        orderId: orderA.id,
        customerUserId: customer.userId,
      }),
      applyCoupon.execute({
        code: 'ONEPERUSER',
        orderId: orderB.id,
        customerUserId: customer.userId,
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await ctx.prisma.couponRedemption.count({ where: { status: 'APPLIED' } }),
    ).toBe(1);
  });

  it('refuses to spend one customer’s allowance on another customer’s order', async () => {
    const { order } = await couponAndOrder({ code: 'SAVE10' });
    const intruder = await createUserWithRole(ctx, 'CUSTOMER');

    await expect(
      applyCoupon.execute({
        code: 'SAVE10',
        orderId: order.id,
        customerUserId: intruder.userId,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.ORDER_NOT_FOUND });
    expect(await ctx.prisma.couponRedemption.count()).toBe(0);
  });

  it('applies a pharmacy-scoped coupon to an order, where the pharmacy is known', async () => {
    const pharmacyId = `pharmacy-${randomUUID()}`;
    const { customer, order } = await couponAndOrder({
      code: 'PHARMA',
      coupon: { scope: { pharmacyIds: [pharmacyId] } },
      pharmacyId,
    });

    const result = await applyCoupon.execute({
      code: 'PHARMA',
      orderId: order.id,
      customerUserId: customer.userId,
    });

    expect(result.discountAmount).toBe(100);
  });

  it('reverses a redemption, returning the usage to the pool', async () => {
    const { customer, order } = await couponAndOrder({
      code: 'SAVE10',
      coupon: { usageLimitGlobal: 1, usageLimitPerUser: 1 },
    });
    await applyCoupon.execute({
      code: 'SAVE10',
      orderId: order.id,
      customerUserId: customer.userId,
    });

    const reversed = await reverseCoupon.execute({ orderId: order.id, code: 'SAVE10' });

    expect(reversed).toMatchObject({ status: 'REVERSED', replay: false, discountAmount: 100 });
    // The row is still there — the record of what happened is not deleted.
    expect(await ctx.prisma.couponRedemption.count()).toBe(1);
    expect(
      await ctx.prisma.couponRedemption.count({ where: { status: 'APPLIED' } }),
    ).toBe(0);

    // And the freed usage can be spent again.
    const secondOrder = await seedOrder(customer.userId, [
      { productId: (await seedProduct({ price: 1_000 })).id, unitPrice: 1_000, quantity: 1 },
    ]);
    const again = await applyCoupon.execute({
      code: 'SAVE10',
      orderId: secondOrder.id,
      customerUserId: customer.userId,
    });
    expect(again.discountAmount).toBe(100);
  });

  it('replays a reversal without a second write', async () => {
    const { customer, order } = await couponAndOrder({ code: 'SAVE10' });
    await applyCoupon.execute({
      code: 'SAVE10',
      orderId: order.id,
      customerUserId: customer.userId,
    });
    await reverseCoupon.execute({ orderId: order.id, code: 'SAVE10' });

    const replay = await reverseCoupon.execute({ orderId: order.id, code: 'SAVE10' });

    expect(replay.replay).toBe(true);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'COUPON_REVERSED' } }),
    ).toBe(1);
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'coupon.reversed' } }),
    ).toBe(1);
  });

  it('never creates a redemption when reversing one that does not exist', async () => {
    const { order } = await couponAndOrder({ code: 'SAVE10' });

    await expect(
      reverseCoupon.execute({ orderId: order.id, code: 'SAVE10' }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(await ctx.prisma.couponRedemption.count()).toBe(0);
  });

  it('records the audit entries and the catalogued coupon events for both movements', async () => {
    const { customer, order } = await couponAndOrder({ code: 'SAVE10' });
    const applied = await applyCoupon.execute({
      code: 'SAVE10',
      orderId: order.id,
      customerUserId: customer.userId,
    });
    await reverseCoupon.execute({ orderId: order.id, code: 'SAVE10', reason: 'cancelled' });

    const audits = await ctx.prisma.auditLog.findMany({
      where: { resourceType: 'CouponRedemption', resourceId: applied.redemptionId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['COUPON_REDEEMED', 'COUPON_REVERSED']);
    expect(audits[0].context).toMatchObject({
      orderId: order.id,
      discountAmount: 100,
      outcome: 'APPLIED',
    });
    expect(audits[1].context).toMatchObject({ reason: 'cancelled', outcome: 'REVERSED' });

    const events = await ctx.prisma.outbox.findMany({
      where: { aggregateType: 'Coupon' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual(['coupon.redeemed', 'coupon.reversed']);
    // Exactly the two — no invented coupon.validated/created/updated.
    expect(
      await ctx.prisma.outbox.count({
        where: {
          aggregateType: 'Coupon',
          eventType: { notIn: ['coupon.redeemed', 'coupon.reversed'] },
        },
      }),
    ).toBe(0);
  });

  it('rolls the redemption back when the transaction fails', async () => {
    const { customer, order } = await couponAndOrder({
      code: 'EXPIRED',
      coupon: { expiresAt: '2020-01-01T00:00:00.000Z' },
    });

    await expect(
      applyCoupon.execute({
        code: 'EXPIRED',
        orderId: order.id,
        customerUserId: customer.userId,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.COUPON_EXPIRED });

    expect(await ctx.prisma.couponRedemption.count()).toBe(0);
    expect(await ctx.prisma.outbox.count({ where: { aggregateType: 'Coupon' } })).toBe(0);
  });

  it('exposes validate, apply and reverse to other modules in-process', async () => {
    const { customer, order } = await couponAndOrder({ code: 'SAVE10' });

    // What Module 06's checkout and cancellation sagas will call. Not wired into either.
    const applied = await couponPort.apply({
      code: 'SAVE10',
      orderId: order.id,
      customerUserId: customer.userId,
    });
    const reversed = await couponPort.reverse({ orderId: order.id, code: 'SAVE10' });
    const quoted = await couponPort.validate({
      customerUserId: customer.userId,
      code: 'SAVE10',
    });

    expect(applied.discountAmount).toBe(100);
    expect(reversed.status).toBe('REVERSED');
    // No cart, so nothing is in scope — and validating still wrote nothing.
    expect(quoted.valid).toBe(false);
    expect(await ctx.prisma.couponRedemption.count()).toBe(1);
  });

  it('leaves Module 06 checkout untouched — no order carries a discount from this task', async () => {
    const { customer, order } = await couponAndOrder({ code: 'SAVE10' });
    await applyCoupon.execute({
      code: 'SAVE10',
      orderId: order.id,
      customerUserId: customer.userId,
    });

    // The redemption exists, but nothing has rewritten the order's totals: composing the discount
    // into `discountTotal`/`grandTotal` is the integration task's decision, not this one's.
    const row = await ctx.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.discountTotal).toBe(0);
    expect(row.grandTotal).toBe(1_000);
  });
});
