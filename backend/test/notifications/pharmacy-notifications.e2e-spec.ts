import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { LicenseExpirySweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/license-expiry.sweeper';
import { createDomainEvent, DomainEvent } from '../../src/shared/events/domain-event';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { auth, body, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, grantOrgRole } from '../pharmacy-inventory/support';

interface Item {
  id: string;
  type: string | null;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
}

const PHARMACY_TYPES = ['PHARMACY_ACTIVATED', 'PHARMACY_SUSPENDED'];

/**
 * Module 13 Work 07 against real PostgreSQL and the real HTTP stack.
 *
 * Activation is the real path — the owner registers the pharmacy, an administrator activates it
 * through `POST /pharmacy/activate` — and suspension is Module 04's own licence-expiry sweeper.
 * Events go through the real outbox relay and the recipient through the real Module 04 port. The
 * recipient policy under test is the one the repository defines: the organization's owner, one
 * user. Managers and pharmacists of the same pharmacy receive nothing, by design.
 */
describe('Pharmacy notifications (e2e)', () => {
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

  const inbox = async (token: string, query: Record<string, unknown> = {}) =>
    (body(await request(ctx.server).get('/notifications').query(query).set(...auth(token)).expect(200)) as { items: Item[] }).items;
  const pharmacyItems = async (token: string) => (await inbox(token)).filter((i) => PHARMACY_TYPES.includes(i.type ?? ''));

  async function stranger() {
    const u = await registerAndVerify(ctx);
    return { ...u, ...(await login(ctx, u.phone, u.password)) };
  }

  /** An active pharmacy whose licence has just lapsed, suspended by Module 04's own sweep. */
  async function suspendedPharmacy() {
    const pharmacy = await createActivatedPharmacy(ctx, { licenseExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) });
    await ctx.drainOutbox();
    // Test-only clock control, as other suites backdate: the licence on the pharmacy row lapses.
    await ctx.prisma.pharmacy.update({ where: { id: pharmacy.pharmacyId }, data: { licenseExpiresAt: new Date(Date.now() - 60_000) } });
    expect(await ctx.app.get(LicenseExpirySweeper).run()).toBe(1);
    await ctx.drainOutbox();
    return pharmacy;
  }

  // ===========================================================================================
  // 1. The two events
  // ===========================================================================================

  describe('events', () => {
    it('pharmacy.pharmacy.activated → the owner, exactly once; its manager, pharmacist and others get none', async () => {
      const pharmacy = await createActivatedPharmacy(ctx);
      const manager = await grantOrgRole(ctx, 'PHARMACY_MANAGER', pharmacy.organizationId);
      const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);
      const other = await stranger();
      await ctx.drainOutbox();

      expect(await pharmacyItems(pharmacy.accessToken)).toEqual([
        expect.objectContaining({
          type: 'PHARMACY_ACTIVATED',
          category: 'SYSTEM',
          title: 'Pharmacy activated',
          body: 'Your pharmacy has been activated on PharmaLink.',
          data: { pharmacyId: pharmacy.pharmacyId },
          read: false,
        }),
      ]);
      for (const u of [manager, pharmacist, other]) expect(await inbox(u.accessToken)).toEqual([]);

      const stored = await ctx.prisma.notification.findMany({ where: { templateCode: { in: PHARMACY_TYPES } } });
      expect(stored.map((n) => [n.recipientUserId, n.channel, n.status, n.eventType])).toEqual([
        [pharmacy.userId, 'IN_APP', 'SENT', 'pharmacy.pharmacy.activated'],
      ]);
      const envelope = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'pharmacy.pharmacy.activated', aggregateId: pharmacy.pharmacyId } });
      expect(stored[0].dedupeKey).toBe(`${(envelope.payload as unknown as DomainEvent).id}:${pharmacy.userId}`);
    });

    it('rendered in the owner’s language, read from Module 01', async () => {
      const pharmacy = await createActivatedPharmacy(ctx);
      await request(ctx.server).patch('/users/me').set(...auth(pharmacy.accessToken)).send({ preferredLanguage: 'am' }).expect(200);
      await ctx.drainOutbox();
      expect(await pharmacyItems(pharmacy.accessToken)).toEqual([expect.objectContaining({ title: 'ፋርማሲዎ ነቅቷል', body: 'ፋርማሲዎ በፋርማሊንክ ላይ ነቅቷል።' })]);
    });

    it('pharmacy.pharmacy.suspended (licence expired) → the owner, exactly once, with the reason code', async () => {
      const pharmacy = await suspendedPharmacy();
      const manager = await grantOrgRole(ctx, 'PHARMACY_MANAGER', pharmacy.organizationId);
      const suspended = (await pharmacyItems(pharmacy.accessToken)).filter((i) => i.type === 'PHARMACY_SUSPENDED');
      expect(suspended).toEqual([
        expect.objectContaining({
          category: 'SYSTEM',
          title: 'Pharmacy suspended',
          body: 'Your pharmacy has been suspended because its licence has expired.',
          data: { pharmacyId: pharmacy.pharmacyId, reason: 'LICENSE_EXPIRED' },
        }),
      ]);
      expect(await inbox(manager.accessToken)).toEqual([]);
    });

    it('an event for an unknown pharmacy writes nothing', async () => {
      const bus = ctx.app.get(EventBusService);
      const before = await ctx.prisma.notification.count();
      await bus.publish(
        createDomainEvent({ type: 'pharmacy.pharmacy.activated', aggregateType: 'Pharmacy', aggregateId: randomUUID(), payload: { pharmacyId: randomUUID(), organizationId: randomUUID() } }),
      );
      await bus.publish(
        createDomainEvent({ type: 'pharmacy.pharmacy.suspended', aggregateType: 'Pharmacy', aggregateId: randomUUID(), payload: { pharmacyId: randomUUID(), reason: 'MANUAL' } }),
      );
      expect(await ctx.prisma.notification.count()).toBe(before);
    });
  });

  // ===========================================================================================
  // 2. Idempotency, inbox, privacy, audit
  // ===========================================================================================

  describe('idempotency', () => {
    it('a redelivered or concurrently delivered activation writes one notification', async () => {
      const pharmacy = await createActivatedPharmacy(ctx);
      await ctx.drainOutbox();
      // Module 13 is the only consumer of pharmacy.pharmacy.activated, so replaying it touches nothing else.
      for (let i = 0; i < 2; i += 1) {
        await ctx.prisma.outbox.updateMany({ where: { eventType: 'pharmacy.pharmacy.activated', aggregateId: pharmacy.pharmacyId }, data: { publishedAt: null } });
        await ctx.drainOutbox();
      }
      const row = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'pharmacy.pharmacy.activated', aggregateId: pharmacy.pharmacyId } });
      await Promise.all(Array.from({ length: 5 }, () => ctx.app.get(EventBusService).publish(row.payload as unknown as DomainEvent)));
      expect(await ctx.prisma.notification.count({ where: { templateCode: 'PHARMACY_ACTIVATED' } })).toBe(1);
    });
  });

  describe('inbox', () => {
    it('serves it through GET /notifications; the owner marks it READ, another user cannot', async () => {
      const pharmacy = await createActivatedPharmacy(ctx);
      const manager = await grantOrgRole(ctx, 'PHARMACY_MANAGER', pharmacy.organizationId);
      await ctx.drainOutbox();
      const [activated] = await pharmacyItems(pharmacy.accessToken);

      await request(ctx.server).post(`/notifications/${activated.id}/read`).set(...auth(manager.accessToken)).send({}).expect(404);
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: activated.id } })).status).toBe('SENT');
      const read = body(await request(ctx.server).post(`/notifications/${activated.id}/read`).set(...auth(pharmacy.accessToken)).send({}).expect(200));
      expect(read).toMatchObject({ id: activated.id, type: 'PHARMACY_ACTIVATED', read: true });
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: activated.id } })).status).toBe('READ');
    });

    it('stores and serves no organization, licence, staff, customer or contact data', async () => {
      const pharmacy = await suspendedPharmacy();
      const stored = JSON.stringify(await ctx.prisma.notification.findMany({ where: { templateCode: { in: PHARMACY_TYPES } } }));
      const served = JSON.stringify(await pharmacyItems(pharmacy.accessToken));
      for (const f of [pharmacy.organizationId, 'organizationId', 'licenseNumber', 'licenseExpiresAt', 'Test Pharmacy', 'displayName', pharmacy.phone, 'ownerUserId']) {
        expect({ f, stored: stored.includes(f), served: served.includes(f) }).toEqual({ f, stored: false, served: false });
      }
      expect(served).not.toContain(pharmacy.userId);
    });

    it('creation wrote no Module 13 audit entry; reads, count, read and read-all append none', async () => {
      const pharmacy = await createActivatedPharmacy(ctx);
      await ctx.drainOutbox();
      expect(
        await ctx.prisma.auditLog.count({ where: { OR: [{ resourceType: { contains: 'otification' } }, { action: { contains: 'NOTIFICATION' } }] } }),
      ).toBe(0);
      const before = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      const [first] = await pharmacyItems(pharmacy.accessToken);
      await request(ctx.server).get('/notifications/unread-count').set(...auth(pharmacy.accessToken)).expect(200);
      await request(ctx.server).post(`/notifications/${first.id}/read`).set(...auth(pharmacy.accessToken)).send({}).expect(200);
      await request(ctx.server).post('/notifications/read-all').set(...auth(pharmacy.accessToken)).send({}).expect(200);
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

    it('Module 13 never touches Module 04 (or Module 01 organization) persistence, repositories, entities or infrastructure', () => {
      for (const file of files()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'prisma.pharmacy',
          'prisma.branch',
          'prisma.organization',
          'prisma.userRole',
          'PHARMACY_REPOSITORY',
          'BRANCH_REPOSITORY',
          'pharmacy-inventory/domain/entities',
          'pharmacy-inventory/domain/repositories',
          'pharmacy-inventory/infrastructure/',
          'pharmacy-inventory/application/commands/',
          'pharmacy-inventory/application/queries/',
          'pharmacy-inventory/application/ports/outbound',
          'getOrganizationOwner',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Module 13 reaches Module 04 only through the pharmacy-recipient port, the event contract and the module', () => {
      const imports = new Set<string>();
      for (const file of files()) {
        for (const m of readFileSync(file, 'utf8').matchAll(/from '(?:\.\.\/)+(pharmacy-inventory\/[^']*)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'pharmacy-inventory/application/ports/inbound/pharmacy-recipient-read.port',
        'pharmacy-inventory/domain/events',
        'pharmacy-inventory/pharmacy-inventory.module',
      ]);
    });
  });
});
