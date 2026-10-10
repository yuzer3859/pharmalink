import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { createActivatedPharmacy, PharmacyOwnerContext } from '../pharmacy-inventory/support';
import {
  auth,
  body,
  createUserWithRole,
  login,
  registerAndVerify,
  RegisteredUser,
  Tokens,
} from '../support/fixtures';
import { TestContext } from '../support/test-app';
import { resetDatabase } from '../support/test-database';

/**
 * Module 06's repository contracts (module-06 `06-orders-spec.md` §2, ADR-002) store
 * `customerUserId`/`pharmacyId`/`branchId`/`catalogProductId`/etc. as plain, unconstrained
 * `String` columns — confirmed against `prisma/schema/06-orders.prisma` (no cross-module FK).
 * These repository tests therefore need no Identity/Catalog/Pharmacy fixture data: arbitrary
 * strings are valid, exactly as they would be for a real cross-module scalar reference validated
 * at the application layer, not the database layer (mirrors
 * `test/prescription-matching/support.ts`'s identical finding for module-05).
 *
 * No commands/controllers/module wiring exist yet for `orders` (this task's own boundary —
 * `06-orders-spec.md` §14 stops at "Repositories"), so these tests connect a `PrismaService`
 * directly against the throwaway container database (`test/global-setup.ts`) rather than booting
 * `AppModule` via `createTestApp()` (`test/support/test-app.ts`), which would require wiring a
 * Nest module for this slice that this task does not build.
 */
export async function createPrisma(): Promise<PrismaService> {
  const prisma = new PrismaService();
  await prisma.$connect();
  return prisma;
}

export async function resetOrdersTables(prisma: PrismaService): Promise<void> {
  await resetDatabase(prisma);
}

/* ------------------------------------------------------------------------------------------ *
 * HTTP fixtures (Task 7). Shared by the Module 06 HTTP e2e specs so the multi-module setup a
 * placed order requires — a priced Catalog product, an activated Pharmacy holding stock, a
 * Module 02 address, a cart — is written once rather than per spec.
 * ------------------------------------------------------------------------------------------ */

/**
 * An `ACTIVE`, priced catalog product. `price` goes through Module 03's own admin contract —
 * Catalog owns the reference price, so no fixture writes `products.price` behind the
 * repository. `kind` selects the Rx shape: `OTC`/`RX` medicines, or an unclassified
 * `HEALTH_PRODUCT` (`rxClassification` is mandatory for `MEDICINE`, module-03 §3.6 invariant 1).
 */
export async function createPricedProduct(
  ctx: TestContext,
  options: { price?: number | null; kind?: 'OTC' | 'RX' | 'HEALTH_PRODUCT' } = {},
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
  const price = options.price === undefined ? 2500 : options.price;
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

  const product = body(
    await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send(price === null ? payload : { ...payload, price })
      .expect(201),
  );
  const productId = product.id as string;

  // Published only through catalogue review (module-16 Work 30): submit (DRAFT -> PENDING_REVIEW), then approve (-> ACTIVE).
  await request(ctx.server).post(`/admin/catalog/review/${productId}/submit`).set(...auth(admin.accessToken)).expect(200);
  await request(ctx.server).post(`/admin/catalog/review/${productId}/approve`).set(...auth(admin.accessToken)).expect(200);

  return productId;
}

/**
 * Repoints a catalog product's reference price through Module 03's own `PATCH
 * /admin/catalog/products/:id` — the contract a real curator uses. Lets a test move the
 * authoritative price out from under an already-built cart without touching `products` directly.
 */
export async function setProductPrice(
  ctx: TestContext,
  catalogProductId: string,
  price: number,
): Promise<void> {
  const admin = await createUserWithRole(ctx, 'ADMIN');
  await request(ctx.server)
    .patch(`/admin/catalog/products/${catalogProductId}`)
    .set(...auth(admin.accessToken))
    .send({ price })
    .expect(200);
}

/** An activated pharmacy stocking `quantity` units of `catalogProductId`; the owner's tokens are
 * returned so fulfillment routes can be called as that pharmacy. */
export async function createStockedPharmacy(
  ctx: TestContext,
  catalogProductId: string,
  quantity = 50,
): Promise<PharmacyOwnerContext & { branchId: string }> {
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
  return { ...pharmacy, branchId: branch.branchId as string };
}

/** A verified, logged-in customer (registration already grants CUSTOMER). */
export async function createCustomer(ctx: TestContext): Promise<RegisteredUser & Tokens> {
  const user = await registerAndVerify(ctx);
  const tokens = await login(ctx, user.phone, user.password);
  return { ...user, ...tokens };
}

export async function createCustomerAddress(ctx: TestContext, accessToken: string): Promise<string> {
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

export interface PlacedOrder {
  customer: RegisteredUser & Tokens;
  pharmacy: PharmacyOwnerContext & { branchId: string };
  catalogProductId: string;
  orderId: string;
  fulfillmentId: string;
}

/**
 * Drives the real `POST /checkout` to produce a genuine `PAID` order with a `PENDING`
 * fulfillment — the precondition every `/orders/*` and `/pharmacy/orders/*` route needs. Built
 * through the HTTP surface rather than by inserting rows, so the fixture exercises the same
 * saga a real client would and can never drift from it.
 */
export interface ReadyToCheckout {
  user: RegisteredUser & Tokens;
  pharmacy: PharmacyOwnerContext & { branchId: string };
  addressId: string;
  catalogProductId: string;
  cartId: string;
}

/**
 * Everything `POST /checkout` needs, stopping just short of calling it: a priced Catalog product,
 * an activated pharmacy holding stock, a Module 02 address, and an `ACTIVE` cart whose
 * `indicativePrice` already matches the catalog price (so the §10 `PRICE_CHANGED` gate passes).
 * Shared so the atomicity/concurrency suites can drive a real checkout without each re-deriving
 * this multi-module setup.
 */
export async function readyToCheckout(
  ctx: TestContext,
  options: { quantity?: number; stock?: number; kind?: 'OTC' | 'RX' | 'HEALTH_PRODUCT' } = {},
): Promise<ReadyToCheckout> {
  const user = await createCustomer(ctx);
  const catalogProductId = await createPricedProduct(ctx, { kind: options.kind });
  const pharmacy = await createStockedPharmacy(ctx, catalogProductId, options.stock ?? 50);
  const addressId = await createCustomerAddress(ctx, user.accessToken);

  const cart = await ctx.prisma.cart.create({
    data: { customerUserId: user.userId, status: 'ACTIVE' },
  });
  await ctx.prisma.cartItem.create({
    data: {
      cartId: cart.id,
      catalogProductId,
      quantity: options.quantity ?? 2,
      indicativePrice: 2500,
    },
  });

  return { user, pharmacy, addressId, catalogProductId, cartId: cart.id };
}

export async function placeOrder(
  ctx: TestContext,
  options: { quantity?: number; stock?: number; kind?: 'OTC' | 'RX' | 'HEALTH_PRODUCT' } = {},
): Promise<PlacedOrder> {
  const { user: customer, pharmacy, addressId, catalogProductId } = await readyToCheckout(
    ctx,
    options,
  );

  const checkout = body(
    await request(ctx.server)
      .post('/checkout')
      .set(...auth(customer.accessToken))
      .send({ addressId, idempotencyKey: randomUUID() })
      .expect(201),
  );
  const orderId = checkout.orderId as string;

  const fulfillment = await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId } });

  return { customer, pharmacy, catalogProductId, orderId, fulfillmentId: fulfillment.id };
}
