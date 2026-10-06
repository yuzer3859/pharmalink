import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AuthorizePaymentCommand } from '../../src/modules/payment/application/commands/authorize-payment.command';
import { SpendWalletCommand } from '../../src/modules/payment/application/commands/spend-wallet.command';
import { TopUpWalletCommand } from '../../src/modules/payment/application/commands/top-up-wallet.command';
import { PaymentMethod } from '../../src/modules/payment/domain/enums';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;

interface Item {
  id: string;
  type: string | null;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
}

const WALLET_TYPES = ['WALLET_CREDITED', 'WALLET_DEBITED'];

/**
 * Module 13 Work 08 against real PostgreSQL.
 *
 * The wallet moves through Module 07's own commands — `TopUpWalletCommand` (credit) and
 * `SpendWalletCommand` (debit) — exactly as Module 07's wallet suite drives them: neither has an
 * HTTP route yet (top-up waits for an order-less payment path; spend is internal to checkout). The
 * funding payment is authorized by the real command and marked captured directly, the same fixture
 * `test/payment/wallet.e2e-spec.ts` uses and documents. Events go through the real outbox relay and
 * the recipient is the event's own `userId`.
 */
describe('Wallet notifications (e2e)', () => {
  let ctx: TestContext;
  let authorize: AuthorizePaymentCommand;
  let topUp: TopUpWalletCommand;
  let spend: SpendWalletCommand;
  let userA: User;
  let userB: User;

  beforeAll(async () => {
    ctx = await createTestApp();
    authorize = ctx.app.get(AuthorizePaymentCommand);
    topUp = ctx.app.get(TopUpWalletCommand);
    spend = ctx.app.get(SpendWalletCommand);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    userA = await createUserWithRole(ctx, 'CUSTOMER');
    userB = await createUserWithRole(ctx, 'CUSTOMER');
    await ctx.drainOutbox(); // setup events first, so each test drains only what it causes
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — Module 07's own commands, as its wallet suite uses them
  // -------------------------------------------------------------------------------------------

  async function seedOrder(customerUserId: string, grandTotal: number) {
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId,
        status: 'PENDING_PAYMENT',
        subtotal: grandTotal,
        deliveryFee: 0,
        platformFee: 0,
        discountTotal: 0,
        grandTotal,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: false,
      },
    });
    await ctx.prisma.fulfillment.create({ data: { orderId: order.id, pharmacyId: `pharmacy-${randomUUID()}`, branchId: `branch-${randomUUID()}` } });
    return order;
  }

  /** A real top-up: a captured, unallocated funding payment moved into the wallet. */
  async function credit(user: User, amount: number) {
    const order = await seedOrder(user.userId, amount);
    const authorized = await authorize.execute({
      customerUserId: user.userId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    await ctx.prisma.payment.update({ where: { id: authorized.paymentId }, data: { status: 'CAPTURED', capturedAt: new Date() } });
    const result = await topUp.execute({ customerUserId: user.userId, paymentId: authorized.paymentId, idempotencyKey: `wallet-topup-${randomUUID()}` });
    await ctx.drainOutbox();
    return result;
  }

  /** A real spend from the wallet against an order. */
  async function debit(user: User, amount: number) {
    const order = await seedOrder(user.userId, amount);
    const result = await spend.execute({ customerUserId: user.userId, orderId: order.id, amount, idempotencyKey: `wallet-spend-${randomUUID()}` });
    await ctx.drainOutbox();
    return result;
  }

  const inbox = async (token: string, query: Record<string, unknown> = {}) =>
    (body(await request(ctx.server).get('/notifications').query(query).set(...auth(token)).expect(200)) as { items: Item[] }).items;
  const walletItems = async (token: string) => (await inbox(token)).filter((i) => WALLET_TYPES.includes(i.type ?? ''));

  // ===========================================================================================
  // 1. The two events, through Module 07's commands
  // ===========================================================================================

  describe('events', () => {
    it('wallet.credited → user A exactly once, with the amount the wallet received; user B none', async () => {
      await credit(userA, 25_000);
      expect(await walletItems(userA.accessToken)).toEqual([
        expect.objectContaining({
          type: 'WALLET_CREDITED',
          category: 'TRANSACTIONAL',
          title: 'Wallet credited',
          body: 'Your PharmaLink wallet has been credited with 250.00 ETB.',
          data: { amount: 25_000, currency: 'ETB' },
          read: false,
        }),
      ]);
      expect(await inbox(userB.accessToken)).toEqual([]);
      const stored = await ctx.prisma.notification.findFirstOrThrow({ where: { templateCode: 'WALLET_CREDITED' } });
      expect(stored).toMatchObject({ recipientUserId: userA.userId, channel: 'IN_APP', status: 'SENT', eventType: 'wallet.credited' });
      const envelope = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'wallet.credited' } });
      expect(stored.dedupeKey).toBe(`${(envelope.payload as unknown as DomainEvent).id}:${userA.userId}`);
    });

    it('wallet.debited → user A exactly once, in Amharic, with the amount deducted; user B none', async () => {
      await credit(userA, 25_000);
      await request(ctx.server).patch('/users/me').set(...auth(userA.accessToken)).send({ preferredLanguage: 'am' }).expect(200);
      await debit(userA, 8_000);
      const debits = (await walletItems(userA.accessToken)).filter((i) => i.type === 'WALLET_DEBITED');
      expect(debits).toEqual([
        expect.objectContaining({ title: 'ከዋሌትዎ ገንዘብ ተቀንሷል', body: 'ከፋርማሊንክ ዋሌትዎ 80.00 ETB ተቀንሷል።', data: { amount: 8_000, currency: 'ETB' } }),
      ]);
      expect(await inbox(userB.accessToken)).toEqual([]);
    });
  });

  // ===========================================================================================
  // 2. Idempotency, inbox, privacy, audit
  // ===========================================================================================

  describe('idempotency', () => {
    it('a redelivered or concurrently delivered wallet.credited writes one notification', async () => {
      await credit(userA, 10_000);
      // Module 13 is the only consumer of wallet.credited, so replaying it touches nothing else.
      for (let i = 0; i < 2; i += 1) {
        await ctx.prisma.outbox.updateMany({ where: { eventType: 'wallet.credited' }, data: { publishedAt: null } });
        await ctx.drainOutbox();
      }
      const row = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'wallet.credited' } });
      await Promise.all(Array.from({ length: 5 }, () => ctx.app.get(EventBusService).publish(row.payload as unknown as DomainEvent)));
      expect(await ctx.prisma.notification.count({ where: { templateCode: 'WALLET_CREDITED' } })).toBe(1);
    });
  });

  describe('inbox', () => {
    it('serves them through GET /notifications; the owner marks one READ, another user cannot', async () => {
      await credit(userA, 10_000);
      const [credited] = await walletItems(userA.accessToken);
      await request(ctx.server).post(`/notifications/${credited.id}/read`).set(...auth(userB.accessToken)).send({}).expect(404);
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: credited.id } })).status).toBe('SENT');
      const read = body(await request(ctx.server).post(`/notifications/${credited.id}/read`).set(...auth(userA.accessToken)).send({}).expect(200));
      expect(read).toMatchObject({ id: credited.id, type: 'WALLET_CREDITED', read: true });
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: credited.id } })).status).toBe('READ');
    });

    it('stores and serves no ledger reference, balance, payment, provider, account or other user data', async () => {
      const topped = await credit(userA, 25_000);
      await debit(userA, 8_000);
      const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: topped.paymentId } });
      const ledgerRefs = (await ctx.prisma.ledgerTransaction.findMany({ select: { reference: true } })).map((t) => t.reference);
      const stored = JSON.stringify(await ctx.prisma.notification.findMany({ where: { templateCode: { in: WALLET_TYPES } } }));
      const served = JSON.stringify(await walletItems(userA.accessToken));
      const forbidden = [
        ...ledgerRefs, topped.ledgerReference, topped.paymentId, 'balance', 'ledger', 'paymentId', 'providerToken', 'providerRef',
        'accountId', 'idempotencyKey', userA.phone, userB.userId,
      ];
      if (payment.providerRef) forbidden.push(payment.providerRef);
      if (payment.providerToken) forbidden.push(payment.providerToken);
      for (const f of forbidden) {
        expect({ f, stored: stored.includes(f), served: served.includes(f) }).toEqual({ f, stored: false, served: false });
      }
      expect(served).not.toContain(userA.userId);
    });

    it('creation wrote no Module 13 audit entry; reads, count, read and read-all append none', async () => {
      await credit(userA, 10_000);
      expect(
        await ctx.prisma.auditLog.count({ where: { OR: [{ resourceType: { contains: 'otification' } }, { action: { contains: 'NOTIFICATION' } }] } }),
      ).toBe(0);
      const before = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      const [first] = await walletItems(userA.accessToken);
      await request(ctx.server).get('/notifications/unread-count').set(...auth(userA.accessToken)).expect(200);
      await request(ctx.server).post(`/notifications/${first.id}/read`).set(...auth(userA.accessToken)).send({}).expect(200);
      await request(ctx.server).post('/notifications/read-all').set(...auth(userA.accessToken)).send({}).expect(200);
      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(before);
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

    it('Module 13 never touches the wallet or ledger: no Prisma, repository, service, entity or infrastructure', () => {
      for (const file of files()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'prisma.wallet',
          'prisma.ledger',
          'WALLET_REPOSITORY',
          'LEDGER_REPOSITORY',
          'WALLET_PORT',
          'WalletAccountingService',
          'payment/application/services/',
          'payment/domain/entities',
          'payment/domain/repositories',
          'payment/infrastructure/',
          'payment/application/commands/',
          'payment/application/queries/',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Module 13’s Module 07 imports are unchanged by Work 08: the event contract, Work 03’s port and the module', () => {
      const imports = new Set<string>();
      for (const file of files()) {
        for (const m of readFileSync(file, 'utf8').matchAll(/from '(?:\.\.\/)+(payment\/[^']*)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'payment/application/ports/inbound/payment-recipient-read.port',
        'payment/domain/events',
        'payment/payment.module',
      ]);
    });
  });
});
