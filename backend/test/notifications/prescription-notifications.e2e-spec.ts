import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AssignVerifyingPharmacyCommand } from '../../src/modules/prescription-matching/application/commands/assign-verifying-pharmacy.command';
import { createDomainEvent, DomainEvent } from '../../src/shared/events/domain-event';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { auth, body, createUserWithRole, login, registerAndVerify, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, grantOrgRole } from '../pharmacy-inventory/support';

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

const RX_TYPES = ['PRESCRIPTION_APPROVED', 'PRESCRIPTION_REJECTED', 'MATCHING_FAILED'];
const FILE_REF = 'enc://rx/secret-scan-ref-0042';
const REJECT_REASON = 'Prescription is older than 30 days';

/**
 * Module 13 Work 06 against real PostgreSQL and the real HTTP stack.
 *
 * Every event is caused through Module 05's own surface: the customer uploads (`POST
 * /prescriptions`), a pharmacist at the verifying pharmacy approves or rejects
 * (`/pharmacy/verification/:id/...`), and the customer's own match request runs out of pharmacies
 * (`/matching/find` → `select` → `rematch`). Events are published by the real outbox relay, and the
 * customer is resolved by the real Module 05 recipient port.
 */
describe('Prescription & matching notifications (e2e)', () => {
  let ctx: TestContext;
  let customerA: User;
  let customerB: User;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    customerA = await newCustomer();
    customerB = await newCustomer();
  });

  // -------------------------------------------------------------------------------------------
  // Helpers — Module 03/04/05's own routes
  // -------------------------------------------------------------------------------------------

  async function newCustomer(): Promise<User> {
    const registered = await registerAndVerify(ctx);
    return { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
  }

  // Unique per call: Module 03 refuses a duplicate manufacturer name and a duplicate medicine.
  let productSeq = 0;
  async function activeProduct(): Promise<string> {
    productSeq += 1;
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const mfr = body(
      await request(ctx.server).post('/admin/catalog/manufacturers').set(...auth(admin.accessToken)).send({ name: `Acme Pharma ${productSeq}` }).expect(201),
    );
    const product = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(admin.accessToken))
        .send({
          type: 'MEDICINE',
          genericName: 'Amoxicillin',
          manufacturerId: mfr.id,
          dosageForm: 'CAPSULE',
          strengthValue: 500,
          strengthUnit: 'MG',
          rxClassification: 'OTC',
          nameEn: 'Amoxicillin 500mg',
        })
        .expect(201),
    );
    // Published only through catalogue review (module-16 Work 30): submit (DRAFT -> PENDING_REVIEW), then approve (-> ACTIVE).
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(admin.accessToken)).expect(200);
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(admin.accessToken)).expect(200);
    return product.id as string;
  }

  /** An uploaded prescription, assigned to a pharmacy whose pharmacist can review it. */
  async function uploadedForReview(customer: User) {
    const pharmacy = await createActivatedPharmacy(ctx);
    const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);
    const uploaded = body(
      await request(ctx.server).post('/prescriptions').set(...auth(customer.accessToken)).send({ fileRef: FILE_REF, fileType: 'application/pdf' }).expect(201),
    );
    const prescriptionId = uploaded.id as string;
    await ctx.app.get(AssignVerifyingPharmacyCommand).execute({ prescriptionId, pharmacyId: pharmacy.organizationId });
    return { prescriptionId, pharmacy, pharmacist };
  }

  async function approvedPrescription(customer: User) {
    const productId = await activeProduct();
    const review = await uploadedForReview(customer);
    await request(ctx.server)
      .post(`/pharmacy/verification/${review.prescriptionId}/approve`)
      .set(...auth(review.pharmacist.accessToken))
      .send({ lines: [{ catalogProductId: productId, approvedQuantity: 21, refillsAllowed: 0, isSingleUse: false }], legibilityOk: true, validityOk: true })
      .expect(200);
    await ctx.drainOutbox();
    return { ...review, productId };
  }

  async function rejectedPrescription(customer: User) {
    const review = await uploadedForReview(customer);
    await request(ctx.server)
      .post(`/pharmacy/verification/${review.prescriptionId}/reject`)
      .set(...auth(review.pharmacist.accessToken))
      .send({ reason: REJECT_REASON })
      .expect(200);
    await ctx.drainOutbox();
    return review;
  }

  /** The customer's match request runs out of pharmacies: find → select the only one → rematch. */
  async function failedMatch(customer: User) {
    const productId = await activeProduct();
    const pharmacy = await createActivatedPharmacy(ctx);
    const branch = body(await request(ctx.server).post('/pharmacy/branches').set(...auth(pharmacy.accessToken)).send({ name: 'Main Branch' }).expect(201));
    await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(pharmacy.accessToken))
      .send({
        catalogProductId: productId,
        branchId: branch.branchId,
        price: 300,
        batchNumber: 'B-1',
        initialQuantity: 10,
        expiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      })
      .expect(201);
    const lines = [{ catalogProductId: productId, quantity: 2 }];
    const found = body(await request(ctx.server).post('/matching/find').set(...auth(customer.accessToken)).send({ lines }).expect(201)) as unknown as {
      matchRequest: { id: string };
    };
    const matchRequestId = found.matchRequest.id;
    await request(ctx.server).post(`/matching/${matchRequestId}/select`).set(...auth(customer.accessToken)).send({ pharmacyId: pharmacy.pharmacyId, lines }).expect(200);
    const rematched = body(await request(ctx.server).post(`/matching/${matchRequestId}/rematch`).set(...auth(customer.accessToken)).send({ lines }).expect(200));
    expect(rematched.status).toBe('FAILED');
    await ctx.drainOutbox();
    return { matchRequestId, pharmacy, productId };
  }

  const inbox = async (token: string, query: Record<string, unknown> = {}) =>
    (body(await request(ctx.server).get('/notifications').query(query).set(...auth(token)).expect(200)) as { items: Item[] }).items;
  const rxItems = async (token: string) => (await inbox(token)).filter((i) => RX_TYPES.includes(i.type ?? ''));

  // ===========================================================================================
  // 1. The three events, caused through Module 05
  // ===========================================================================================

  describe('events', () => {
    it('prescription.approved → customer A, exactly once, holding only the prescription reference', async () => {
      const { prescriptionId, pharmacist } = await approvedPrescription(customerA);
      expect(await rxItems(customerA.accessToken)).toEqual([
        expect.objectContaining({
          type: 'PRESCRIPTION_APPROVED',
          category: 'TRANSACTIONAL',
          title: 'Prescription approved',
          body: 'Your prescription has been reviewed and approved by a pharmacist.',
          data: { prescriptionId },
          read: false,
        }),
      ]);
      expect(await inbox(customerB.accessToken)).toEqual([]);
      expect(await inbox(pharmacist.accessToken)).toEqual([]);
      const stored = await ctx.prisma.notification.findFirstOrThrow({ where: { templateCode: 'PRESCRIPTION_APPROVED' } });
      expect(stored).toMatchObject({ recipientUserId: customerA.userId, channel: 'IN_APP', status: 'SENT', eventType: 'prescription.approved' });
      const envelope = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'prescription.approved', aggregateId: prescriptionId } });
      expect(stored.dedupeKey).toBe(`${(envelope.payload as unknown as DomainEvent).id}:${customerA.userId}`);
    });

    it('prescription.rejected → customer A, in Amharic, with the pharmacist’s reason in data only', async () => {
      await request(ctx.server).patch('/users/me').set(...auth(customerA.accessToken)).send({ preferredLanguage: 'am' }).expect(200);
      const { prescriptionId } = await rejectedPrescription(customerA);
      const [n] = await rxItems(customerA.accessToken);
      expect(n).toMatchObject({
        type: 'PRESCRIPTION_REJECTED',
        title: 'የሐኪም ማዘዣዎ አልጸደቀም',
        body: 'የሐኪም ማዘዣዎ ከግምገማ በኋላ አልጸደቀም።',
        data: { prescriptionId, reason: REJECT_REASON },
      });
      expect(`${n.title} ${n.body}`).not.toContain('30 days');
      // The same reason Module 05 already shows the customer on their own prescription.
      const own = body(await request(ctx.server).get(`/prescriptions/${prescriptionId}`).set(...auth(customerA.accessToken)).expect(200));
      expect(own.rejectionReason).toBe(REJECT_REASON);
      expect(await inbox(customerB.accessToken)).toEqual([]);
    });

    it('matching.match_failed → customer A, exactly once, with only the match request reference', async () => {
      const { matchRequestId } = await failedMatch(customerA);
      expect(await rxItems(customerA.accessToken)).toEqual([
        expect.objectContaining({
          type: 'MATCHING_FAILED',
          title: 'No pharmacy found',
          body: 'We could not find a pharmacy able to fulfil your request.',
          data: { matchRequestId },
        }),
      ]);
      expect(await inbox(customerB.accessToken)).toEqual([]);
    });

    it('events naming an unknown prescription or match request write nothing', async () => {
      const bus = ctx.app.get(EventBusService);
      const before = await ctx.prisma.notification.count();
      for (const [type, aggregateType, payload] of [
        ['prescription.approved', 'Prescription', { prescriptionId: randomUUID(), lines: [] }],
        ['prescription.rejected', 'Prescription', { prescriptionId: randomUUID(), reason: 'x' }],
        ['matching.match_failed', 'MatchRequest', { matchRequestId: randomUUID() }],
      ] as const) {
        await bus.publish(createDomainEvent({ type, aggregateType, aggregateId: randomUUID(), payload }));
      }
      expect(await ctx.prisma.notification.count()).toBe(before);
    });
  });

  // ===========================================================================================
  // 2. Idempotency, inbox, privacy, audit
  // ===========================================================================================

  describe('idempotency', () => {
    it('a redelivered or concurrently delivered approval writes one notification', async () => {
      const { prescriptionId } = await approvedPrescription(customerA);
      // Module 13 is the only consumer of prescription.approved, so replaying it touches nothing else.
      for (let i = 0; i < 2; i += 1) {
        await ctx.prisma.outbox.updateMany({ where: { eventType: 'prescription.approved', aggregateId: prescriptionId }, data: { publishedAt: null } });
        await ctx.drainOutbox();
      }
      const row = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'prescription.approved', aggregateId: prescriptionId } });
      await Promise.all(Array.from({ length: 5 }, () => ctx.app.get(EventBusService).publish(row.payload as unknown as DomainEvent)));
      expect(await ctx.prisma.notification.count({ where: { templateCode: 'PRESCRIPTION_APPROVED' } })).toBe(1);
    });
  });

  describe('inbox', () => {
    it('serves them through GET /notifications; the owner marks one READ, another customer cannot', async () => {
      await approvedPrescription(customerA);
      const [approved] = await rxItems(customerA.accessToken);
      await request(ctx.server).post(`/notifications/${approved.id}/read`).set(...auth(customerB.accessToken)).send({}).expect(404);
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: approved.id } })).status).toBe('SENT');
      const read = body(await request(ctx.server).post(`/notifications/${approved.id}/read`).set(...auth(customerA.accessToken)).send({}).expect(200));
      expect(read).toMatchObject({ id: approved.id, type: 'PRESCRIPTION_APPROVED', read: true });
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: approved.id } })).status).toBe('READ');
    });

    it('stores and serves no document reference, medicine, quantity, pharmacy, pharmacist, Fayda or matching data', async () => {
      const approved = await approvedPrescription(customerA);
      const rejected = await rejectedPrescription(customerA);
      const failed = await failedMatch(customerA);
      const stored = JSON.stringify(await ctx.prisma.notification.findMany({ where: { templateCode: { in: RX_TYPES } } }));
      const served = JSON.stringify(await rxItems(customerA.accessToken));
      for (const f of [
        FILE_REF, 'enc://', 'fileRef', 'storageRef', 'fileType', approved.productId, failed.productId, 'catalogProductId', 'approvedQuantity',
        'lines', 'Amoxicillin', approved.pharmacy.organizationId, approved.pharmacy.pharmacyId, failed.pharmacy.pharmacyId,
        approved.pharmacist.userId, rejected.pharmacist.userId, 'faydaId', 'candidates', 'chosenResult', 'excludedPharmacyId', 'distanceMeters',
        customerA.phone,
      ]) {
        expect({ f, stored: stored.includes(f), served: served.includes(f) }).toEqual({ f, stored: false, served: false });
      }
      expect(served).not.toContain(customerA.userId);
    });

    it('creation wrote no Module 13 audit entry; reads, count, read and read-all append none', async () => {
      await approvedPrescription(customerA);
      expect(
        await ctx.prisma.auditLog.count({ where: { OR: [{ resourceType: { contains: 'otification' } }, { action: { contains: 'NOTIFICATION' } }] } }),
      ).toBe(0);
      const before = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      const [first] = await rxItems(customerA.accessToken);
      await request(ctx.server).get('/notifications/unread-count').set(...auth(customerA.accessToken)).expect(200);
      await request(ctx.server).post(`/notifications/${first.id}/read`).set(...auth(customerA.accessToken)).send({}).expect(200);
      await request(ctx.server).post('/notifications/read-all').set(...auth(customerA.accessToken)).send({}).expect(200);
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

    it('Module 13 never touches Module 05 persistence, repositories, entities, commands, queries or infrastructure', () => {
      for (const file of files()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'prisma.prescription',
          'prisma.matchRequest',
          'prisma.matchCandidate',
          'prisma.dispense',
          'PRESCRIPTION_REPOSITORY',
          'MATCH_REPOSITORY',
          'VERIFICATION_REPOSITORY',
          'prescription-matching/domain/entities',
          'prescription-matching/domain/repositories',
          'prescription-matching/domain/enums',
          'prescription-matching/infrastructure/',
          'prescription-matching/application/commands/',
          'prescription-matching/application/queries/',
          'prescription-matching/application/ports/outbound',
          'MATCHING_PORT',
          'DISPENSING_PORT',
          'CHECK_RX_GATE_PORT',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Module 13 reaches Module 05 only through the recipient port, the event contract and the module', () => {
      const imports = new Set<string>();
      for (const file of files()) {
        for (const m of readFileSync(file, 'utf8').matchAll(/from '(?:\.\.\/)+(prescription-matching\/[^']*)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'prescription-matching/application/ports/inbound/prescription-recipient-read.port',
        'prescription-matching/domain/events',
        'prescription-matching/prescription-matching.module',
      ]);
    });
  });
});
