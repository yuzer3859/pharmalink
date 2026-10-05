import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createDomainEvent, DomainEvent } from '../../src/shared/events/domain-event';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { auth, body } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createCustomer, placeOrder, PlacedOrder } from '../orders/support';

interface Item {
  id: string;
  type: string | null;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
}

const LIFECYCLE = ['ORDER_ACCEPTED', 'ORDER_READY', 'ORDER_CANCELLED'];

/**
 * Module 13 Work 02 against real PostgreSQL and the real HTTP stack.
 *
 * Every lifecycle event is caused by Module 06's own routes — the pharmacy accepting and marking
 * ready, the customer cancelling, the pharmacy declining into a no-match cancellation — and
 * published by the real outbox relay. What can only be shown here: that the customer Module 06
 * records on the order receives the notification and a second customer does not, that a
 * redelivered event still leaves one row, and that Work 01's inbox serves and reads them.
 */
describe('Order lifecycle notifications (e2e)', () => {
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

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  const pharmacyAction = (o: PlacedOrder, action: 'accept' | 'prepare' | 'ready') =>
    request(ctx.server).post(`/pharmacy/orders/${o.fulfillmentId}/${action}`).set(...auth(o.pharmacy.accessToken)).expect(200);

  const inbox = async (token: string, query: Record<string, unknown> = {}) =>
    (body(await request(ctx.server).get('/notifications').query(query).set(...auth(token)).expect(200)) as { items: Item[] })
      .items;
  const lifecycle = async (token: string) => (await inbox(token)).filter((i) => LIFECYCLE.includes(i.type ?? ''));

  const setLanguage = (token: string, preferredLanguage: 'am' | 'en') =>
    request(ctx.server).patch('/users/me').set(...auth(token)).send({ preferredLanguage }).expect(200);

  async function envelopeOf(eventType: string, orderId: string): Promise<DomainEvent> {
    const row = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType, aggregateId: orderId } });
    return row.payload as unknown as DomainEvent;
  }

  // ===========================================================================================
  // 1. Each event, caused through Module 06
  // ===========================================================================================

  describe('events', () => {
    it('accepted and ready → customer A, once each, from the order’s own customer; customer B gets nothing', async () => {
      const order = await placeOrder(ctx);
      const customerB = await createCustomer(ctx);

      await pharmacyAction(order, 'accept');
      await ctx.drainOutbox();
      await pharmacyAction(order, 'prepare');
      await pharmacyAction(order, 'ready');
      await ctx.drainOutbox();

      const items = await lifecycle(order.customer.accessToken);
      expect(items.map((i) => [i.type, i.category, i.title, i.data, i.read])).toEqual([
        ['ORDER_READY', 'TRANSACTIONAL', 'Order ready', { orderId: order.orderId }, false],
        ['ORDER_ACCEPTED', 'TRANSACTIONAL', 'Order accepted', { orderId: order.orderId }, false],
      ]);
      expect(await inbox(customerB.accessToken)).toEqual([]);
      expect(await inbox(order.pharmacy.accessToken)).toEqual([]);

      const stored = await ctx.prisma.notification.findMany({
        where: { templateCode: { in: LIFECYCLE } },
        orderBy: { templateCode: 'asc' },
      });
      expect(stored.map((n) => [n.recipientUserId, n.channel, n.status, n.eventType])).toEqual([
        [order.customer.userId, 'IN_APP', 'SENT', 'order.accepted'],
        [order.customer.userId, 'IN_APP', 'SENT', 'order.ready'],
      ]);
      const accepted = await envelopeOf('order.accepted', order.orderId);
      expect(stored[0].dedupeKey).toBe(`${accepted.id}:${order.customer.userId}`);
    });

    it('cancelled by the customer → their cancellation, in Amharic, without echoing their reason in the text', async () => {
      const order = await placeOrder(ctx);
      await setLanguage(order.customer.accessToken, 'am');
      await request(ctx.server)
        .post(`/orders/${order.orderId}/cancel`)
        .set(...auth(order.customer.accessToken))
        .send({ reason: 'Ordered by mistake' })
        .expect(200);
      await ctx.drainOutbox();

      expect(await lifecycle(order.customer.accessToken)).toEqual([
        expect.objectContaining({
          type: 'ORDER_CANCELLED',
          title: 'ትዕዛዝዎ ተሰርዟል',
          body: 'ትዕዛዝዎ ተሰርዟል።',
          data: { orderId: order.orderId, reason: 'Ordered by mistake' },
        }),
      ]);
    });

    it('cancelled because no pharmacy could take it → the customer, worded for that, without the pharmacist’s reason', async () => {
      const order = await placeOrder(ctx);
      await request(ctx.server)
        .post(`/pharmacy/orders/${order.fulfillmentId}/decline`)
        .set(...auth(order.pharmacy.accessToken))
        .send({ reason: 'Out of stock on the shelf' })
        .expect(200);
      await ctx.drainOutbox();

      const items = await lifecycle(order.customer.accessToken);
      expect(items).toEqual([
        expect.objectContaining({
          type: 'ORDER_CANCELLED',
          body: 'No pharmacy could fulfil your order, so it has been cancelled.',
          data: { orderId: order.orderId, reason: 'NO_PHARMACY_MATCH' },
        }),
      ]);
      expect(JSON.stringify(items)).not.toContain('Out of stock');
      expect(await inbox(order.pharmacy.accessToken)).toEqual([]);
    });

    it('an event for an order that does not exist writes nothing', async () => {
      const before = await ctx.prisma.notification.count();
      await ctx.app.get(EventBusService).publish(
        createDomainEvent({
          type: 'order.ready',
          aggregateType: 'Order',
          aggregateId: randomUUID(),
          payload: { orderId: randomUUID(), fulfillmentId: randomUUID() },
        }),
      );
      expect(await ctx.prisma.notification.count()).toBe(before);
    });
  });

  // ===========================================================================================
  // 2. Idempotency, inbox, privacy, audit
  // ===========================================================================================

  describe('idempotency', () => {
    it('a redelivered or concurrently delivered lifecycle event writes one notification', async () => {
      const order = await placeOrder(ctx);
      await pharmacyAction(order, 'accept');
      await ctx.drainOutbox();

      for (let i = 0; i < 2; i += 1) {
        await ctx.prisma.outbox.updateMany({ where: { eventType: 'order.accepted', aggregateId: order.orderId }, data: { publishedAt: null } });
        await ctx.drainOutbox();
      }
      const event = await envelopeOf('order.accepted', order.orderId);
      await Promise.all(Array.from({ length: 5 }, () => ctx.app.get(EventBusService).publish(event)));

      expect(await ctx.prisma.notification.count({ where: { templateCode: 'ORDER_ACCEPTED' } })).toBe(1);
    });
  });

  describe('inbox', () => {
    it('appears through GET /notifications, can be marked READ through Work 01’s route, and only by its owner', async () => {
      const order = await placeOrder(ctx);
      const customerB = await createCustomer(ctx);
      await pharmacyAction(order, 'accept');
      await ctx.drainOutbox();
      const [accepted] = await lifecycle(order.customer.accessToken);

      await request(ctx.server).post(`/notifications/${accepted.id}/read`).set(...auth(customerB.accessToken)).send({}).expect(404);
      const read = body(
        await request(ctx.server).post(`/notifications/${accepted.id}/read`).set(...auth(order.customer.accessToken)).send({}).expect(200),
      );
      expect(read).toMatchObject({ id: accepted.id, type: 'ORDER_ACCEPTED', read: true });
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: accepted.id } })).status).toBe('READ');
      expect((await inbox(order.customer.accessToken, { unread: 'true' })).map((i) => i.type)).not.toContain('ORDER_ACCEPTED');
    });

    it('carries no contact detail, pharmacy, fulfillment, payment or driver data, and no recipient', async () => {
      const order = await placeOrder(ctx);
      await pharmacyAction(order, 'accept');
      await pharmacyAction(order, 'prepare');
      await pharmacyAction(order, 'ready');
      await ctx.drainOutbox();
      const raw = JSON.stringify(await lifecycle(order.customer.accessToken));
      for (const forbidden of [
        order.customer.userId, order.customer.phone, order.pharmacy.pharmacyId, order.pharmacy.userId, order.fulfillmentId,
        'fulfillmentId', 'pharmacyId', 'customerUserId', 'driverId', 'paymentId', 'recipientUserId', 'dedupeKey', 'Bole',
      ]) {
        expect({ forbidden, found: raw.includes(forbidden) }).toEqual({ forbidden, found: false });
      }
    });

    it('creating and reading lifecycle notifications appends no audit entry of Module 13’s', async () => {
      const order = await placeOrder(ctx);
      // Publish the setup's own events first (registration, checkout), whose other consumers may
      // audit; the snapshot then isolates what order.accepted's delivery causes.
      await ctx.drainOutbox();
      await pharmacyAction(order, 'accept');
      const beforeDrain = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      await ctx.drainOutbox();
      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(beforeDrain);

      const [accepted] = await lifecycle(order.customer.accessToken);
      await inbox(order.customer.accessToken);
      await request(ctx.server).get('/notifications/unread-count').set(...auth(order.customer.accessToken)).expect(200);
      await request(ctx.server).post(`/notifications/${accepted.id}/read`).set(...auth(order.customer.accessToken)).send({}).expect(200);
      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(beforeDrain);
    });
  });

  // ===========================================================================================
  // 3. Boundaries
  // ===========================================================================================

  describe('boundaries', () => {
    const moduleRoot = join(__dirname, '..', '..', 'src', 'modules', 'notifications');
    const files = (): string[] => {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
        }
      };
      walk(moduleRoot);
      return out;
    };

    it('Module 13 never touches Module 06 persistence, repositories, entities, commands, queries or infrastructure', () => {
      for (const file of files()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'prisma.order',
          'prisma.fulfillment',
          'prisma.cart',
          'ORDER_REPOSITORY',
          'FULFILLMENT_REPOSITORY',
          'orders/domain/entities',
          'orders/domain/repositories',
          'orders/domain/enums',
          'orders/infrastructure/',
          'orders/application/commands/',
          'orders/application/queries/',
          'orders/application/ports/outbound',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Module 13 reaches Module 06 only through the recipient port, the event contract and OrdersModule', () => {
      const imports = new Set<string>();
      for (const file of files()) {
        for (const m of readFileSync(file, 'utf8').matchAll(/from '(?:\.\.\/)+(orders\/[^']*)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'orders/application/ports/inbound/order-recipient-read.port',
        'orders/domain/events',
        'orders/orders.module',
      ]);
    });
  });
});
