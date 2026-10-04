import request from 'supertest';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

async function activeCatalogProduct(ctx: TestContext, nameEn: string) {
  const admin = await createUserWithRole(ctx, 'ADMIN');
  const mfr = body(
    await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(admin.accessToken))
      .send({ name: `Acme Pharma (${nameEn})` })
      .expect(201),
  );
  const product = body(
    await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send({
        type: 'MEDICINE',
        genericName: nameEn,
        manufacturerId: mfr.id,
        dosageForm: 'TABLET',
        strengthValue: 250,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        nameEn,
      })
      .expect(201),
  );
  await request(ctx.server)
    .post(`/admin/catalog/products/${product.id as string}/status`)
    .set(...auth(admin.accessToken))
    .send({ status: 'ACTIVE' })
    .expect(200);
  return product.id as string;
}

/**
 * Module-04 hardening — dispatch fulfillment scoping (backend/docs/04-pharmacy-inventory-spec.md
 * §8/§14.7). `findDispatchMovements`/`getReservationFulfillment` used to scope purely by
 * `refType=ORDER, refId=orderId`, ignoring `reservationId` entirely — ambiguous once one order
 * holds more than one reservation. Now scoped by the persisted `stock_movements.reservationId`
 * back-reference, so dispatching one reservation can never suppress or leak into another
 * reservation's fulfillment state, even under the same order.
 */
describe('Dispatch fulfillment is scoped to the exact reservation (e2e)', () => {
  let ctx: TestContext;
  let inventoryPort: IInventoryPort;

  beforeAll(async () => {
    ctx = await createTestApp();
    inventoryPort = ctx.app.get<IInventoryPort>(INVENTORY_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  it('one order reserving two different listings: dispatching the first reservation does not ' +
    'mark the second (undispatched) reservation as dispatched, and each fulfillment query ' +
    'returns only its own quantity/batches', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );
    const productA = await activeCatalogProduct(ctx, 'Amoxicillin 250mg');
    const productB = await activeCatalogProduct(ctx, 'Ibuprofen 400mg');
    const listingA = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productA,
          branchId: branch.branchId,
          price: 500,
          batchNumber: 'A-1',
          initialQuantity: 10,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    const listingB = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productB,
          branchId: branch.branchId,
          price: 700,
          batchNumber: 'B-1',
          initialQuantity: 10,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );

    const orderId = 'order-multi-listing-1';
    const reservationA = await inventoryPort.reserve({
      listingId: listingA.listingId as string,
      quantity: 3,
      orderId,
      idempotencyKey: 'idem-multi-a',
    });
    const reservationB = await inventoryPort.reserve({
      listingId: listingB.listingId as string,
      quantity: 5,
      orderId,
      idempotencyKey: 'idem-multi-b',
    });
    await inventoryPort.confirm({ reservationId: reservationA.reservationId });
    await inventoryPort.confirm({ reservationId: reservationB.reservationId });

    // Dispatch only reservation A.
    await inventoryPort.dispatch({ reservationId: reservationA.reservationId });

    const fulfillmentA = await inventoryPort.getReservationFulfillment(reservationA.reservationId);
    expect(fulfillmentA.dispatched).toBe(true);
    expect(fulfillmentA.dispatchedQuantity).toBe(3);

    // Reservation B, under the SAME order, must still be reported as undispatched.
    const fulfillmentBBefore = await inventoryPort.getReservationFulfillment(reservationB.reservationId);
    expect(fulfillmentBBefore.dispatched).toBe(false);
    expect(fulfillmentBBefore.dispatchedQuantity).toBe(0);

    // Now dispatch reservation B successfully.
    await inventoryPort.dispatch({ reservationId: reservationB.reservationId });
    const fulfillmentBAfter = await inventoryPort.getReservationFulfillment(reservationB.reservationId);
    expect(fulfillmentBAfter.dispatched).toBe(true);
    expect(fulfillmentBAfter.dispatchedQuantity).toBe(5);

    // A's fulfillment is unaffected by B's dispatch.
    const fulfillmentAAfter = await inventoryPort.getReservationFulfillment(reservationA.reservationId);
    expect(fulfillmentAAfter.dispatchedQuantity).toBe(3);

    // Retrying both dispatches is idempotent: no duplicate DISPATCH movements or outbox events.
    await inventoryPort.dispatch({ reservationId: reservationA.reservationId });
    await inventoryPort.dispatch({ reservationId: reservationB.reservationId });

    const dispatchMovementsA = await ctx.prisma.stockMovement.count({
      where: { listingId: listingA.listingId as string, type: 'DISPATCH', reservationId: reservationA.reservationId },
    });
    expect(dispatchMovementsA).toBe(1);
    const dispatchMovementsB = await ctx.prisma.stockMovement.count({
      where: { listingId: listingB.listingId as string, type: 'DISPATCH', reservationId: reservationB.reservationId },
    });
    expect(dispatchMovementsB).toBe(1);

    const dispatchedOutboxEvents = await ctx.prisma.outbox.count({
      where: { eventType: 'pharmacy.stock.dispatched' },
    });
    expect(dispatchedOutboxEvents).toBe(2);
  });

  it('one order reserving the SAME listing twice (two separate reservations): dispatching one ' +
    'does not affect the other\'s fulfillment state', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );
    const productId = await activeCatalogProduct(ctx, 'Paracetamol 500mg (dup-listing)');
    const listing = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productId,
          branchId: branch.branchId,
          price: 300,
          batchNumber: 'C-1',
          initialQuantity: 20,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    const listingId = listing.listingId as string;
    const orderId = 'order-same-listing-twice';

    const reservation1 = await inventoryPort.reserve({
      listingId,
      quantity: 2,
      orderId,
      idempotencyKey: 'idem-same-listing-1',
    });
    const reservation2 = await inventoryPort.reserve({
      listingId,
      quantity: 6,
      orderId,
      idempotencyKey: 'idem-same-listing-2',
    });
    await inventoryPort.confirm({ reservationId: reservation1.reservationId });
    await inventoryPort.confirm({ reservationId: reservation2.reservationId });

    await inventoryPort.dispatch({ reservationId: reservation1.reservationId });

    const fulfillment1 = await inventoryPort.getReservationFulfillment(reservation1.reservationId);
    expect(fulfillment1.dispatched).toBe(true);
    expect(fulfillment1.dispatchedQuantity).toBe(2);

    // Same order AND same listing — still must not be conflated.
    const fulfillment2 = await inventoryPort.getReservationFulfillment(reservation2.reservationId);
    expect(fulfillment2.dispatched).toBe(false);
    expect(fulfillment2.dispatchedQuantity).toBe(0);

    await inventoryPort.dispatch({ reservationId: reservation2.reservationId });
    const fulfillment2After = await inventoryPort.getReservationFulfillment(reservation2.reservationId);
    expect(fulfillment2After.dispatched).toBe(true);
    expect(fulfillment2After.dispatchedQuantity).toBe(6);
    expect((await inventoryPort.getReservationFulfillment(reservation1.reservationId)).dispatchedQuantity).toBe(2);
  });
});
