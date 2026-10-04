import { randomUUID } from 'crypto';
import request from 'supertest';
import { MATCHING_PORT } from '../../src/modules/prescription-matching/application/ports/inbound/matching.port';
import { ApiException } from '../../src/shared/errors/api-exception';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { createActivatedPharmacy } from '../pharmacy-inventory/support';
import {
  auth,
  body,
  createUserWithRole,
  errorOf,
  grantRoleDirect,
  login,
  registerAndVerify,
  RegisteredUser,
  Tokens,
} from '../support/fixtures';
import {
  FEE_BASE_CONFIG_KEY,
  FEE_PER_KM_CONFIG_KEY,
} from '../../src/modules/delivery/application/services/delivery-fee-settings';
import { AppConfigService } from '../../src/shared/config/app-config.service';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { setProductPrice } from './support';

/**
 * Module 06 Task 6 — `POST /checkout` HTTP layer (`06-orders-spec.md` §9.2/§287). Exercises the
 * real NestJS controller/guard/filter pipeline end-to-end (real `AppModule`, real Postgres, real
 * `JwtAuthGuard`/`PermissionsGuard`/`AllExceptionsFilter`/`ValidationPipe`), following
 * `test/prescription-matching/http-interface.e2e-spec.ts`'s conventions.
 *
 * Scope is the HTTP boundary: authentication, DTO validation, command mapping, response
 * projection, and application-error -> HTTP-status mapping. The saga's internals already have
 * 18 unit tests in `checkout.command.spec.ts` and are not re-tested here.
 *
 * No `/cart` HTTP routes exist yet (a later task), so carts are seeded directly through Prisma —
 * the same direct-Prisma precondition style `test/orders/*-repository.e2e-spec.ts` already uses.
 */
/** `body()` returns `Record<string, unknown>`; this narrows §9.2's nested `totals` shape without
 * sprinkling casts through every assertion. */
function totalsOf(payload: Record<string, unknown>): Record<string, number> {
  return payload.totals as Record<string, number>;
}

describe('Orders — POST /checkout HTTP interface (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  async function customer(): Promise<RegisteredUser & Tokens> {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);
    return { ...user, ...tokens };
  }

  /**
   * An `ACTIVE` catalog product carrying a reference price. `price` is set through Prisma because
   * Module 03's admin DTOs do not expose it — this task added the column the checkout saga's
   * `ICatalogPort.getProduct().price` contract already required, without touching Module 03's
   * application layer.
   *
   * `kind` selects the product shape: an `OTC` medicine, an `RX` medicine, or an unclassified
   * `HEALTH_PRODUCT`. All three are exercised — `RxClassificationPolicy` treats only `'RX'` as
   * requiring a prescription, so both `OTC` and `HEALTH_PRODUCT` must check out without one.
   */
  async function activeProduct(
    options: { price: number | null; kind?: 'OTC' | 'RX' | 'HEALTH_PRODUCT' } = { price: 2500 },
  ): Promise<string> {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const mfr = body(
      await request(ctx.server)
        .post('/admin/catalog/manufacturers')
        .set(...auth(admin.accessToken))
        .send({ name: `Acme ${randomUUID().slice(0, 8)}` })
        .expect(201),
    );
    const kind = options.kind ?? 'OTC';
    const payload =
      kind === 'HEALTH_PRODUCT'
        ? { type: 'HEALTH_PRODUCT', nameEn: 'Vitamin C 500mg' }
        : {
            type: 'MEDICINE',
            genericName: 'Ibuprofen',
            manufacturerId: mfr.id,
            dosageForm: 'TABLET',
            strengthValue: 400,
            strengthUnit: 'MG',
            rxClassification: kind,
            nameEn: 'Ibuprofen 400mg',
          };
    // Price is set through Module 03's own admin contract, never a raw Prisma write: Catalog
    // owns the reference price, so the fixture must exercise the same path a real curator uses.
    // `null` means "leave it unpriced" — the DTO simply omits the field.
    const priced = options.price === null ? payload : { ...payload, price: options.price };

    const product = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(admin.accessToken))
        .send(priced)
        .expect(201),
    );
    const productId = product.id as string;

    await request(ctx.server)
      .post(`/admin/catalog/products/${productId}/status`)
      .set(...auth(admin.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);

    return productId;
  }

  /** A pharmacy holding `quantity` sellable units of `catalogProductId`. */
  async function pharmacyWithStock(catalogProductId: string, quantity: number): Promise<void> {
    const pharmacy = await createActivatedPharmacy(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch', lat: 9.02, lng: 38.75 })
        .expect(201),
    );
    await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(pharmacy.accessToken))
      .send({
        catalogProductId,
        branchId: branch.branchId,
        price: 2500,
        batchNumber: 'B-1',
        initialQuantity: quantity,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .expect(201);
  }

  async function createAddress(accessToken: string): Promise<string> {
    const address = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(accessToken))
        .send({
          recipientName: 'Selam Bekele',
          recipientPhone: '+251911000111',
          city: 'Addis Ababa',
          addressLine: 'Bole Road 12',
          lat: 9.02,
          lng: 38.75,
        })
        .expect(201),
    );
    return address.id as string;
  }

  /** Seeds an `ACTIVE` cart with one line — no `/cart` HTTP route exists yet. */
  async function seedCart(
    customerUserId: string,
    catalogProductId: string,
    quantity: number,
  ): Promise<void> {
    const cart = await ctx.prisma.cart.create({ data: { customerUserId, status: 'ACTIVE' } });
    await ctx.prisma.cartItem.create({
      data: { cartId: cart.id, catalogProductId, quantity, indicativePrice: 2500 },
    });
  }

  /** Full happy-path precondition: priced product, stocked pharmacy, address, non-empty cart. */
  async function readyToCheckout(
    options: { quantity?: number; stock?: number; kind?: 'OTC' | 'RX' | 'HEALTH_PRODUCT' } = {},
  ): Promise<{ user: RegisteredUser & Tokens; addressId: string; catalogProductId: string }> {
    const user = await customer();
    const catalogProductId = await activeProduct({ price: 2500, kind: options.kind });
    await pharmacyWithStock(catalogProductId, options.stock ?? 50);
    const addressId = await createAddress(user.accessToken);
    await seedCart(user.userId, catalogProductId, options.quantity ?? 2);
    return { user, addressId, catalogProductId };
  }

  const validBody = (addressId: string, idempotencyKey = randomUUID()) => ({
    addressId,
    idempotencyKey,
  });

  describe('Successful COD checkout', () => {
    it('places a COD order and returns 201 with the mapped response', async () => {
      const { user, addressId, catalogProductId } = await readyToCheckout();

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send(validBody(addressId))
        .expect(201);

      const data = body(res);
      expect(data.orderId).toEqual(expect.any(String));
      expect(data.orderNumber).toEqual(expect.any(String));
      expect(data.status).toBe('PAID');
      expect(data.isCod).toBe(true);
      expect(data.replay).toBe(false);
      expect(data.currency).toBe('ETB');
      expect(data.invoiceNumber).toEqual(expect.any(String));
      expect(data.pharmacyId).toEqual(expect.any(String));

      // Totals come from the saga's PricingCalculator over the fresh catalog price (2500 x 2).
      expect(data.subtotal).toBe(5000);
      expect(data.grandTotal).toEqual(expect.any(Number));

      expect(data.lines).toEqual([
        { catalogProductId, quantity: 2, unitPrice: 2500, lineTotal: 5000, requiresRx: false },
      ]);

      // The order really was persisted, and the cart was finalized by the saga.
      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { id: data.orderId as string },
      });
      expect(order.customerUserId).toBe(user.userId);
      expect(order.status).toBe('PAID');
      const cart = await ctx.prisma.cart.findFirstOrThrow({
        where: { customerUserId: user.userId },
      });
      expect(cart.status).toBe('CONVERTED');
    });

    it('confirms the Module 04 reservation it holds (module-04 §8 — confirm on payment success)', async () => {
      const { user, addressId } = await readyToCheckout();

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId))
          .expect(201),
      );

      // The reservation the saga holds is reached through the OrderLine that snapshotted its id
      // (matching creates it before the order exists), and it is CONFIRMED, not HELD: COD's
      // payment success *is* this saga's PENDING_PAYMENT -> PAID transition. A still-HELD hold
      // would be reclaimed by Module 04's TTL sweeper and would make the later dispatch at
      // mark-ready fail with INVALID_RESERVATION_STATE. Nothing is mocked here — this is the
      // real IInventoryPort.confirm() against real Postgres.
      const line = await ctx.prisma.orderLine.findFirstOrThrow({
        where: { orderId: data.orderId as string },
      });
      const reservation = await ctx.prisma.stockReservation.findUniqueOrThrow({
        where: { id: line.reservationId as string },
      });
      expect(reservation.status).toBe('CONFIRMED');

      // Confirm is a pure state transition — it moves no stock (module-04 §8: "no quantity
      // change ... no new stock_movements row"); only the later dispatch does.
      const movements = await ctx.prisma.stockMovement.findMany({
        where: { reservationId: reservation.id, type: 'DISPATCH' },
      });
      expect(movements).toHaveLength(0);
    });

    it('rejects with PRICE_CHANGED when the catalog price moved since the confirmed quote', async () => {
      // Spec 10: "cart price diverged from the fresh Module 03 read at step 1; client must
      // re-quote". The cart was confirmed at 2500/unit; the curator then repoints the catalog to
      // 3100 through Module 03's own admin contract. Checkout must refuse rather than silently
      // charging the higher price (parent doc 5.3 — "customer never charged more than confirmed").
      const { user, addressId, catalogProductId } = await readyToCheckout();

      const cartItemBefore = await ctx.prisma.cartItem.findFirstOrThrow({
        where: { catalogProductId },
      });
      expect(cartItemBefore.indicativePrice).toBe(2500);

      await setProductPrice(ctx, catalogProductId, 3100);

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send(validBody(addressId));

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe(ErrorCode.PRICE_CHANGED);

      // Nothing was created and no stock was held: the gate runs before matching/reservation.
      expect(await ctx.prisma.order.count({ where: { customerUserId: user.userId } })).toBe(0);
      expect(await ctx.prisma.stockReservation.count()).toBe(0);
    });

    it('lets the customer re-quote and then check out at the newly confirmed price', async () => {
      // The documented escape from PRICE_CHANGED: "client must re-quote". The quote re-confirms
      // the current price as the cart baseline, after which the same checkout succeeds — and it
      // is charged at the *new* catalog price, so the stale cache never controls what is paid.
      const { user, addressId, catalogProductId } = await readyToCheckout();
      await setProductPrice(ctx, catalogProductId, 3100);

      await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send(validBody(addressId))
        .expect(409);

      const quote = body(
        await request(ctx.server)
          .post('/checkout/quote')
          .set(...auth(user.accessToken))
          .send({ addressId })
          .expect(200),
      );
      expect(totalsOf(quote).subtotal).toBe(6200); // 3100 x 2

      // The quote re-confirmed the baseline on the cart row itself.
      const reconciled = await ctx.prisma.cartItem.findFirstOrThrow({
        where: { catalogProductId },
      });
      expect(reconciled.indicativePrice).toBe(3100);

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId))
          .expect(201),
      );

      expect(data.subtotal).toBe(6200);
      expect(data.lines).toEqual([
        { catalogProductId, quantity: 2, unitPrice: 3100, lineTotal: 6200, requiresRx: false },
      ]);
      const line = await ctx.prisma.orderLine.findFirstOrThrow({
        where: { orderId: data.orderId as string },
      });
      expect(line.unitPrice).toBe(3100);
      expect(line.lineTotal).toBe(6200);
    });

    it('checks out unchanged when the catalog price still matches the confirmed one', async () => {
      const { user, addressId, catalogProductId } = await readyToCheckout();

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId))
          .expect(201),
      );

      expect(data.subtotal).toBe(5000);
      expect(data.lines).toEqual([
        { catalogProductId, quantity: 2, unitPrice: 2500, lineTotal: 5000, requiresRx: false },
      ]);
    });

    it('checks out an unclassified HEALTH_PRODUCT without a prescription', async () => {
      // The sibling happy-path case above uses an OTC *medicine*; this covers the other non-Rx
      // shape (rxClassification null), so both bypass the gate for the right reason.
      const { user, addressId } = await readyToCheckout({ kind: 'HEALTH_PRODUCT' });

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId))
          .expect(201),
      );

      expect(data.status).toBe('PAID');
      expect((data.lines as Array<{ requiresRx: boolean }>)[0].requiresRx).toBe(false);
    });

    it('never exposes internal order columns in the response', async () => {
      const { user, addressId } = await readyToCheckout();

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId))
          .expect(201),
      );

      for (const leaked of ['idempotencyKey', 'matchRequestId', 'paymentId', 'strategy']) {
        expect(data).not.toHaveProperty(leaked);
      }
      // Per-line internals stay internal too.
      for (const line of data.lines as Array<Record<string, unknown>>) {
        expect(line).not.toHaveProperty('reservationId');
        expect(line).not.toHaveProperty('prescriptionLineId');
      }
    });

    it('takes the customer from the access token, ignoring any client-supplied user id', async () => {
      const { user, addressId } = await readyToCheckout();
      const other = await customer();

      // `forbidNonWhitelisted` rejects the attempt outright rather than silently honouring it.
      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send({ ...validBody(addressId), customerUserId: other.userId })
        .expect(400);

      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe('POST /checkout/quote (spec 9.2)', () => {
    it('returns rxGateResult, candidates and totals without creating anything', async () => {
      const { user, addressId } = await readyToCheckout();

      const data = body(
        await request(ctx.server)
          .post('/checkout/quote')
          .set(...auth(user.accessToken))
          .send({ addressId })
          .expect(200),
      );

      expect(data.rxGateResult).toEqual({
        allowed: true,
        blocked: [],
        usablePrescriptionLineIds: [],
      });
      expect(Array.isArray(data.candidates)).toBe(true);
      expect((data.candidates as unknown[]).length).toBeGreaterThan(0);
      expect(totalsOf(data).subtotal).toBe(5000); // 2500 x 2, from the real catalog read

      // "No order created" — and, critically, no stock reserved: the quote must call
      // IMatchingPort.find, never select.
      expect(await ctx.prisma.order.count({ where: { customerUserId: user.userId } })).toBe(0);
      expect(await ctx.prisma.stockReservation.count()).toBe(0);
      expect(await ctx.prisma.fulfillment.count()).toBe(0);
      expect(await ctx.prisma.invoice.count()).toBe(0);
      const cart = await ctx.prisma.cart.findFirstOrThrow({
        where: { customerUserId: user.userId },
      });
      expect(cart.status).toBe('ACTIVE');
    });

    it('rejects an address the caller does not own with 404', async () => {
      const { user } = await readyToCheckout();
      const other = await customer();
      const foreignAddressId = await createAddress(other.accessToken);

      await request(ctx.server)
        .post('/checkout/quote')
        .set(...auth(user.accessToken))
        .send({ addressId: foreignAddressId })
        .expect(404);
    });

    it('rejects an unauthenticated quote with 401', async () => {
      await request(ctx.server)
        .post('/checkout/quote')
        .send({ addressId: randomUUID() })
        .expect(401);
    });
  });


  /**
   * The Module 08 delivery fee, through the real HTTP checkout (F-FEE-01, BR-DEL-09, §5, §6, §7).
   *
   * The rate card ships empty, so every other test in this file quotes and charges zero without
   * knowing Module 08 is involved at all. These tests turn it on through the real `IConfigPort`
   * lookup and assert what changes: the amount `PricingCalculator` receives, the amount frozen on
   * `Order.deliveryFee`, and — the part that matters most — that nothing a client sends can move
   * either.
   */
  describe('Delivery fee (Module 08 integration)', () => {
    const overrides = new Map<string, unknown>();

    beforeEach(() => {
      overrides.clear();
      const config = ctx.app.get(AppConfigService);
      const real = config.get.bind(config);
      jest
        .spyOn(config, 'get')
        .mockImplementation(<T>(key: string): T | undefined =>
          overrides.has(key) ? (overrides.get(key) as T) : real<T>(key),
        );
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('charges the configured delivery fee and freezes it on the order', async () => {
      overrides.set(FEE_BASE_CONFIG_KEY, 2_000);
      const { user, addressId } = await readyToCheckout();

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId))
          .expect(201),
      );

      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { id: data.orderId as string },
      });
      expect(order.deliveryFee).toBe(2_000);
      expect(order.grandTotal).toBe(order.subtotal + 2_000 + order.platformFee - order.discountTotal);
    });

    it('quotes the same fee at /checkout/quote as it charges at /checkout', async () => {
      overrides.set(FEE_BASE_CONFIG_KEY, 2_000).set(FEE_PER_KM_CONFIG_KEY, 1_000);
      const { user } = await readyToCheckout();

      // A destination away from the branch, which this file's fixtures otherwise place at the
      // same coordinates — so the distance component is actually exercised rather than zero.
      const addressId = body(
        await request(ctx.server)
          .post('/addresses')
          .set(...auth(user.accessToken))
          .send({
            recipientName: 'Selam Bekele',
            recipientPhone: '+251911000222',
            city: 'Addis Ababa',
            addressLine: 'Kazanchis, Bldg 4',
            lat: 8.98,
            lng: 38.79,
          })
          .expect(201),
      ).id as string;

      const quoted = body(
        await request(ctx.server)
          .post('/checkout/quote')
          .set(...auth(user.accessToken))
          .send({ addressId })
          .expect(200),
      );
      const placed = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId))
          .expect(201),
      );

      const totals = quoted.totals as Record<string, number>;
      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { id: placed.orderId as string },
      });
      expect(totals.deliveryFee).toBeGreaterThan(2_000);
      expect(order.deliveryFee).toBe(totals.deliveryFee);
    });

    /**
     * §6 and §7. There is no quote token and no `deliveryFee` field in the checkout contract, so a
     * customer holding a stale or edited quote has nothing to send it in — and `forbidNonWhitelisted`
     * turns the attempt into a `400` rather than a silently ignored field.
     */
    it('refuses a client-supplied delivery fee outright', async () => {
      overrides.set(FEE_BASE_CONFIG_KEY, 2_000);
      const { user, addressId } = await readyToCheckout();

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send({ ...validBody(addressId), deliveryFee: 0 });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('charges the rate card in force at checkout, not the one a stale quote saw', async () => {
      overrides.set(FEE_BASE_CONFIG_KEY, 2_000);
      const { user, addressId } = await readyToCheckout();

      const stale = body(
        await request(ctx.server)
          .post('/checkout/quote')
          .set(...auth(user.accessToken))
          .send({ addressId })
          .expect(200),
      );

      // The operator raises the rate card between the quote and the order.
      overrides.set(FEE_BASE_CONFIG_KEY, 3_500);
      const placed = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId))
          .expect(201),
      );

      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { id: placed.orderId as string },
      });
      expect((stale.totals as Record<string, number>).deliveryFee).toBe(2_000);
      expect(order.deliveryFee).toBe(3_500);
    });

    it('leaves the charged amount alone once the order exists', async () => {
      overrides.set(FEE_BASE_CONFIG_KEY, 2_000);
      const { user, addressId } = await readyToCheckout();
      const placed = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId))
          .expect(201),
      );

      // Nothing in Module 08 writes an order, so a later rate-card change cannot reach one.
      overrides.set(FEE_BASE_CONFIG_KEY, 9_999);

      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { id: placed.orderId as string },
      });
      expect(order.deliveryFee).toBe(2_000);
    });
  });

  describe('Authentication and authorization', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const res = await request(ctx.server)
        .post('/checkout')
        .send(validBody(randomUUID()))
        .expect(401);

      expect(errorOf(res).code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('rejects a caller without order:create:own with 403', async () => {
      // Registration auto-grants CUSTOMER (which *does* hold order:create:own), so that grant is
      // removed before the DRIVER grant is added — otherwise this would assert nothing.
      const user = await registerAndVerify(ctx);
      await ctx.prisma.userRole.deleteMany({ where: { userId: user.userId } });
      await grantRoleDirect(ctx, user.userId, 'DRIVER');
      const tokens = await login(ctx, user.phone, user.password);

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(tokens.accessToken))
        .send(validBody(randomUUID()))
        .expect(403);

      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    });
  });

  describe('Request validation', () => {
    it.each([
      ['missing addressId', { idempotencyKey: randomUUID() }],
      ['non-uuid addressId', { addressId: 'not-a-uuid', idempotencyKey: randomUUID() }],
      ['missing idempotencyKey', { addressId: randomUUID() }],
      ['too-short idempotencyKey', { addressId: randomUUID(), idempotencyKey: 'short' }],
      ['unknown field', { addressId: randomUUID(), idempotencyKey: randomUUID(), foo: 'bar' }],
      ['empty body', {}],
    ])('rejects %s with 400 VALIDATION_ERROR', async (_label, payload) => {
      const user = await customer();

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send(payload)
        .expect(400);

      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('rejects an address the caller does not own with 404, not another customer’s order', async () => {
      const { user } = await readyToCheckout();
      const stranger = await customer();
      const strangerAddressId = await createAddress(stranger.accessToken);

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send(validBody(strangerAddressId))
        .expect(404);

      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });
  });

  describe('Idempotency (body field, per §13.5)', () => {
    it('replays the original order for the same customer + key, creating no second order', async () => {
      const { user, addressId } = await readyToCheckout();
      const key = randomUUID();

      const first = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId, key))
          .expect(201),
      );
      const second = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId, key))
          .expect(201),
      );

      expect(second.orderId).toBe(first.orderId);
      expect(second.orderNumber).toBe(first.orderNumber);
      expect(first.replay).toBe(false);
      expect(second.replay).toBe(true);

      const orders = await ctx.prisma.order.count({ where: { customerUserId: user.userId } });
      expect(orders).toBe(1);
    });

    it('returns 409 IDEMPOTENCY_CONFLICT when another customer reuses the key', async () => {
      const { user, addressId } = await readyToCheckout();
      const key = randomUUID();
      await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send(validBody(addressId, key))
        .expect(201);

      const intruder = await readyToCheckout();
      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(intruder.user.accessToken))
        .send(validBody(intruder.addressId, key))
        .expect(409);

      expect(errorOf(res).code).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
    });

    it('collapses concurrent identical requests into exactly one order', async () => {
      const { user, addressId } = await readyToCheckout({ stock: 100 });
      const key = randomUUID();

      const responses = await Promise.all([
        request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId, key)),
        request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId, key)),
      ]);

      // Task 5's race handling resolves the loser to a replay, so both calls succeed.
      for (const res of responses) {
        expect(res.status).toBe(201);
      }
      const orderIds = new Set(responses.map((r) => (r.body as { data: { orderId: string } }).data.orderId));
      expect(orderIds.size).toBe(1);
      expect(await ctx.prisma.order.count({ where: { customerUserId: user.userId } })).toBe(1);
    });
  });

  describe('Application error propagation', () => {
    it('propagates the Rx gate block as 422 RX_REQUIRED', async () => {
      // An RX product with no approved prescription anywhere.
      const { user, addressId } = await readyToCheckout({ kind: 'RX' });

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send(validBody(addressId))
        .expect(422);

      expect(errorOf(res).code).toBe(ErrorCode.RX_REQUIRED);
    });

    it('propagates a matching failure as 409 NO_PHARMACY_MATCH', async () => {
      const user = await customer();
      const catalogProductId = await activeProduct({ price: 2500 });
      // Deliberately no pharmacy stocks this product.
      const addressId = await createAddress(user.accessToken);
      await seedCart(user.userId, catalogProductId, 1);

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send(validBody(addressId))
        .expect(409);

      expect(errorOf(res).code).toBe(ErrorCode.NO_PHARMACY_MATCH);
    });

    it('rejects an empty cart with 400 VALIDATION_ERROR', async () => {
      const user = await customer();
      const addressId = await createAddress(user.accessToken);

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send(validBody(addressId))
        .expect(400);

      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('rejects an unpriced catalog product with 404 CATALOG_PRODUCT_NOT_FOUND', async () => {
      const user = await customer();
      const catalogProductId = await activeProduct({ price: null });
      await pharmacyWithStock(catalogProductId, 10);
      const addressId = await createAddress(user.accessToken);
      await seedCart(user.userId, catalogProductId, 1);

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send(validBody(addressId))
        .expect(404);

      expect(errorOf(res).code).toBe(ErrorCode.CATALOG_PRODUCT_NOT_FOUND);
    });
  });
  /**
   * Coupons at checkout (ADR-019/020/021), over the real HTTP pipeline.
   *
   * The fixture prices one product at 2,500 and the cart holds 2, so every case below starts from
   * a 5,000 subtotal. `test/global-setup.ts` configures a **5% platform commission**, so
   * `platformFee = round(5,000 x 0.05) = 250` and `grandTotal = 5,000 + 250 - discountTotal`
   * (the delivery rate card is empty by default, so Module 08 quotes 0).
   *
   * The non-zero fee is the point rather than an inconvenience: it is what proves the commission
   * is charged on the **pre-discount** subtotal and is left untouched by a platform-funded coupon
   * (ADR-019). With a zero fee these assertions would pass no matter which funding model was
   * implemented.
   *
   * What is *not* re-tested here is the discount arithmetic or the eligibility rules — Module 07's
   * own specs own those. This is the boundary: that a code travels from the DTO to Module 07, that
   * the discount lands in the committed order, that a refusal surfaces as the shared §12 error
   * codes, and that nothing about how the discount is funded leaks to the customer.
   */
  describe('Coupons', () => {
    async function seedCoupon(data: Record<string, unknown>): Promise<string> {
      const coupon = await ctx.prisma.coupon.create({
        data: {
          code: `SAVE-${randomUUID().slice(0, 8)}`.toUpperCase(),
          discountType: 'FIXED',
          value: 750,
          isActive: true,
          ...data,
        },
      });
      return coupon.code;
    }

    it('places an order with no coupon and no discount when none is supplied', async () => {
      const { user, addressId } = await readyToCheckout();

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send(validBody(addressId))
          .expect(201),
      );

      expect(data.subtotal).toBe(5000);
      expect(data.platformFee).toBe(250);
      expect(data.discountTotal).toBe(0);
      expect(data.grandTotal).toBe(5250);
      expect(await ctx.prisma.couponRedemption.count()).toBe(0);
    });

    it('applies a fixed coupon and commits the discounted total', async () => {
      const { user, addressId } = await readyToCheckout();
      const code = await seedCoupon({ discountType: 'FIXED', value: 750 });

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send({ ...validBody(addressId), couponCode: code })
          .expect(201),
      );

      expect(data.subtotal).toBe(5000);
      // The commission is computed on the undiscounted 5,000 — not on 4,250 — so a coupon never
      // reduces what the platform earns. 5,000 + 250 - 750 = 4,500.
      expect(data.platformFee).toBe(250);
      expect(data.discountTotal).toBe(750);
      expect(data.grandTotal).toBe(4500);

      // The persisted order agrees with the response — and `Order.discountTotal` is the one field
      // Module 07's capture reads to book the platform's promotion expense (ADR-019).
      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { id: data.orderId as string },
      });
      expect(order.discountTotal).toBe(750);
      expect(order.platformFee).toBe(250);
      expect(order.grandTotal).toBe(4500);

      // The usage was consumed exactly once, against this order.
      const redemptions = await ctx.prisma.couponRedemption.findMany();
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0]).toMatchObject({
        orderId: data.orderId,
        userId: user.userId,
        discountAmount: 750,
        status: 'APPLIED',
      });
    });

    it('applies a percentage coupon against the repriced checkout lines', async () => {
      const { user, addressId } = await readyToCheckout();
      const code = await seedCoupon({ discountType: 'PERCENT', value: 10 });

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send({ ...validBody(addressId), couponCode: code })
          .expect(201),
      );

      // 10% of the 5,000 the order is actually priced at — the fresh Module 03 price, not the
      // cart's cached `indicativePrice` of 2,500/unit (which would also be 5,000 here, but the
      // saga never reads it; the PRICE_CHANGED tests above prove the two are distinct).
      expect(data.discountTotal).toBe(500);
      expect(data.platformFee).toBe(250);
      expect(data.grandTotal).toBe(4750);
    });

    it('accepts a lower-case code — the same coupon, canonicalized', async () => {
      const { user, addressId } = await readyToCheckout();
      const code = await seedCoupon({ discountType: 'FIXED', value: 750 });

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send({ ...validBody(addressId), couponCode: code.toLowerCase() })
          .expect(201),
      );

      expect(data.discountTotal).toBe(750);
    });

    it('refuses an expired coupon with COUPON_EXPIRED and places no order', async () => {
      const { user, addressId } = await readyToCheckout();
      const code = await seedCoupon({
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send({ ...validBody(addressId), couponCode: code })
        .expect(422);

      expect(errorOf(res).code).toBe(ErrorCode.COUPON_EXPIRED);
      // Refused before the order is created, so there is nothing to compensate.
      expect(await ctx.prisma.order.count()).toBe(0);
      expect(await ctx.prisma.couponRedemption.count()).toBe(0);
    });

    it('refuses an unknown code with COUPON_INVALID, without revealing that it does not exist', async () => {
      const { user, addressId } = await readyToCheckout();

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send({ ...validBody(addressId), couponCode: 'NO-SUCH-CODE' })
        .expect(422);

      // Same code and message a deactivated coupon produces — a client cannot enumerate which
      // promotions exist by checking out against guesses.
      expect(errorOf(res).code).toBe(ErrorCode.COUPON_INVALID);
      expect(await ctx.prisma.order.count()).toBe(0);
    });

    it('rejects a malformed code at the DTO boundary, before any saga work', async () => {
      const { user, addressId } = await readyToCheckout();

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send({ ...validBody(addressId), couponCode: 'not a code!' })
        .expect(400);

      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(await ctx.prisma.order.count()).toBe(0);
    });

    it('applies a pharmacy-scoped coupon when matching chose that pharmacy (ADR-020)', async () => {
      const { user, addressId } = await readyToCheckout();
      // The only stocked pharmacy, so Module 05's matching must choose it.
      const pharmacy = await ctx.prisma.pharmacy.findFirstOrThrow();
      const code = await seedCoupon({
        discountType: 'FIXED',
        value: 750,
        scope: { pharmacyIds: [pharmacy.id] },
      });

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send({ ...validBody(addressId), couponCode: code })
          .expect(201),
      );

      // Decidable only because the quote happens after matching — a cart has no pharmacy, and the
      // preview endpoint would have answered PHARMACY_SCOPE_UNRESOLVABLE for this same coupon.
      expect(data.pharmacyId).toBe(pharmacy.id);
      expect(data.discountTotal).toBe(750);
    });

    it('refuses a coupon scoped to a pharmacy that matching did not choose', async () => {
      const { user, addressId } = await readyToCheckout();
      const code = await seedCoupon({
        discountType: 'FIXED',
        value: 750,
        scope: { pharmacyIds: [randomUUID()] },
      });

      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send({ ...validBody(addressId), couponCode: code })
        .expect(422);

      expect(errorOf(res).code).toBe(ErrorCode.COUPON_INVALID);
      expect(await ctx.prisma.order.count()).toBe(0);
    });

    it('refuses a second use once the per-user limit is spent, leaving the first order intact', async () => {
      const { user, addressId, catalogProductId } = await readyToCheckout({ stock: 50 });
      const code = await seedCoupon({ usageLimitPerUser: 1, usageLimitGlobal: 5 });

      const first = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send({ ...validBody(addressId), couponCode: code })
          .expect(201),
      );
      expect(first.discountTotal).toBe(750);

      // A second checkout by the same customer, same coupon.
      await seedCart(user.userId, catalogProductId, 2);
      const res = await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send({ ...validBody(addressId), couponCode: code })
        .expect(409);

      expect(errorOf(res).code).toBe(ErrorCode.COUPON_USAGE_EXCEEDED);
      // The first order is untouched, and exactly one usage was consumed.
      const orders = await ctx.prisma.order.findMany();
      expect(orders).toHaveLength(1);
      expect(orders[0].status).toBe('PAID');
      expect(await ctx.prisma.couponRedemption.count({ where: { status: 'APPLIED' } })).toBe(1);
    });

    it('never exposes ledger, accounting or redemption internals in the response', async () => {
      const { user, addressId } = await readyToCheckout();
      const code = await seedCoupon({ discountType: 'FIXED', value: 750 });

      const data = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send({ ...validBody(addressId), couponCode: code })
          .expect(201),
      );

      // The customer sees what they were charged. How the discount is funded — the
      // PROMOTION_EXPENSE leg, the provider payable, the redemption row — is Module 07's business
      // and never crosses this boundary (§11's "ledger internals do not cross HTTP").
      for (const leaked of [
        'promotionExpense',
        'providerNet',
        'ledgerReference',
        'redemptionId',
        'couponId',
        'couponCode',
        'discountFunding',
      ]) {
        expect(data).not.toHaveProperty(leaked);
      }
      expect(data.discountTotal).toBe(750);
    });

    it('reverses the redemption when the order is cancelled, moving no money', async () => {
      const { user, addressId } = await readyToCheckout();
      const code = await seedCoupon({ discountType: 'FIXED', value: 750 });

      const placed = body(
        await request(ctx.server)
          .post('/checkout')
          .set(...auth(user.accessToken))
          .send({ ...validBody(addressId), couponCode: code })
          .expect(201),
      );

      await request(ctx.server)
        .post(`/orders/${placed.orderId}/cancel`)
        .set(...auth(user.accessToken))
        .send({ reason: 'Changed my mind' })
        .expect(200);

      const redemption = await ctx.prisma.couponRedemption.findFirstOrThrow();
      expect(redemption.status).toBe('REVERSED');
      // The recorded discount is left exactly as it was — it describes money that really was
      // discounted. Returning money is Module 07's refund flow, not a coupon reversal, and this
      // COD order captured nothing to begin with: no ledger row exists at all.
      expect(redemption.discountAmount).toBe(750);
      expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);

      // The freed usage is spendable again, which is the whole point of reversing it.
      expect(await ctx.prisma.couponRedemption.count({ where: { status: 'APPLIED' } })).toBe(0);
    });
  });
});

/**
 * `INSUFFICIENT_STOCK` surfaces from Module 04's reservation inside `IMatchingPort.select()`, and
 * only when stock is depleted between `find()` and `select()` — a race no HTTP-level fixture can
 * schedule deterministically. Stubbing the port proves the one thing this task owns: that the
 * error reaches the client with the right code and status, unaltered by the controller. The saga's
 * own handling of it is already covered by `checkout.command.spec.ts`.
 */
describe('Orders — POST /checkout insufficient-stock propagation (e2e)', () => {
  let ctx: TestContext;

  class InsufficientStockMatchingPort {
    async find(): Promise<never> {
      throw new ApiException(ErrorCode.INSUFFICIENT_STOCK, 'Not enough stock to reserve.');
    }
    async select(): Promise<never> {
      throw new ApiException(ErrorCode.INSUFFICIENT_STOCK, 'Not enough stock to reserve.');
    }
    async rematch(): Promise<never> {
      throw new ApiException(ErrorCode.INSUFFICIENT_STOCK, 'Not enough stock to reserve.');
    }
  }

  beforeAll(async () => {
    ctx = await createTestApp([
      { provide: MATCHING_PORT, useClass: InsufficientStockMatchingPort },
    ]);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  it('propagates INSUFFICIENT_STOCK as 409', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const admin = await createUserWithRole(ctx, 'ADMIN');
    const product = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(admin.accessToken))
        .send({ type: 'HEALTH_PRODUCT', nameEn: 'Vitamin C 500mg', price: 2500 })
        .expect(201),
    );
    await request(ctx.server)
      .post(`/admin/catalog/products/${product.id as string}/status`)
      .set(...auth(admin.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);

    const address = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(tokens.accessToken))
        .send({
          recipientName: 'Selam Bekele',
          recipientPhone: '+251911000111',
          city: 'Addis Ababa',
          addressLine: 'Bole Road 12',
          lat: 9.02,
          lng: 38.75,
        })
        .expect(201),
    );

    const cart = await ctx.prisma.cart.create({
      data: { customerUserId: user.userId, status: 'ACTIVE' },
    });
    await ctx.prisma.cartItem.create({
      data: {
        cartId: cart.id,
        catalogProductId: product.id as string,
        quantity: 1,
        indicativePrice: 2500,
      },
    });

    const res = await request(ctx.server)
      .post('/checkout')
      .set(...auth(tokens.accessToken))
      .send({ addressId: address.id as string, idempotencyKey: randomUUID() })
      .expect(409);

    expect(errorOf(res).code).toBe(ErrorCode.INSUFFICIENT_STOCK);
  });

});
