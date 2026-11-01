import { randomUUID } from 'crypto';
import request from 'supertest';
import { ExpireVerificationsCommand } from '../../src/modules/identity/application/commands/expire-verifications.command';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { IdentityEventType } from '../../src/modules/identity/domain/events';
import { ORGANIZATION_REPOSITORY } from '../../src/modules/identity/domain/repositories/organization.repository';
import { PrismaOrganizationRepository } from '../../src/modules/identity/infrastructure/persistence/prisma-organization.repository';
import { TransactingEligibilityPolicy } from '../../src/modules/pharmacy-inventory/domain/services/transacting-eligibility.policy';
import { PharmacyInventoryEventType } from '../../src/modules/pharmacy-inventory/domain/events';
import { LicenseExpirySweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/license-expiry.sweeper';
import {
  auth,
  body,
  createUserWithRole,
  errorOf,
  login,
  registerAndVerify,
  RegisteredUser,
  STRONG_PASSWORD,
  Tokens,
} from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/** Fails after the organisation write, inside the approval transaction (test 17). */
class FailingOrganizationRepository extends PrismaOrganizationRepository {
  failNext = false;
  async recordApprovedLicense(
    input: Parameters<PrismaOrganizationRepository['recordApprovedLicense']>[0],
    tx: unknown,
  ): Promise<boolean> {
    const result = await super.recordApprovedLicense(input, tx);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('injected failure after the organisation update');
    }
    return result;
  }
}

interface Owner extends Tokens {
  userId: string;
  email: string;
}

const DAY = 24 * 3600 * 1000;
const LICENCE_DOCS = [{ kind: 'PHARMACY_LICENSE', storageRef: 'enc://verification/licence-1' }];

/**
 * Work 67 — pharmacy licence approval, organisation lifecycle and activation gates, end to end
 * against PostgreSQL and the real HTTP stack:
 *
 *   POST /organizations/pharmacy → Organization PENDING_APPROVAL
 *   POST /verification/documents (organisation-scoped) → PHARMACY_LICENSE PENDING
 *   POST /admin/verification/:id/approve {licenseNumber, expiresAt} → request APPROVED,
 *       Organization ACTIVE with the same licence — the Pharmacy stays PENDING
 *   POST /pharmacy/activate → Pharmacy ACTIVE only on persisted, matching, unexpired evidence
 *
 * plus rejection (initial vs. renewal) and expiry (current vs. superseded licence). Numbers in
 * test names refer to the Work 67 brief's required tests.
 */
describe('Pharmacy licence lifecycle (e2e, Work 67)', () => {
  let ctx: TestContext;
  let failing: FailingOrganizationRepository;
  let admin: RegisteredUser & Tokens;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: ORGANIZATION_REPOSITORY, useClass: FailingOrganizationRepository }]);
    failing = ctx.app.get<FailingOrganizationRepository>(ORGANIZATION_REPOSITORY);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    failing.failNext = false;
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  // -------------------------------------------------------------------------------------------
  // Helpers — every state is reached through the owning module's own route where one exists
  // -------------------------------------------------------------------------------------------

  async function refresh(refreshToken: string): Promise<Tokens> {
    const data = body(await request(ctx.server).post('/auth/token/refresh').send({ refreshToken }).expect(201));
    return { accessToken: data.accessToken as string, refreshToken: data.refreshToken as string };
  }

  /** An e-mail-verified customer, through the real registration and OTP flow. */
  async function customer(): Promise<Owner> {
    const email = `owner-${randomUUID().slice(0, 8)}@pharmalink.test`;
    const registered = await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(201);
    await ctx.drainOutbox();
    const code = ctx.notifications.lastCodeFor(email, 'otp-register');
    await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code, purpose: OtpPurpose.REGISTER }).expect(201);
    return { userId: body(registered).userId as string, email, ...(await login(ctx, email)) };
  }

  /** Applies for a pharmacy organisation (Work 65) and refreshes into the owner's permissions. */
  async function applyFor(owner: Owner, legalName = `Pharmacy ${randomUUID().slice(0, 6)}`): Promise<string> {
    const res = await request(ctx.server)
      .post('/organizations/pharmacy')
      .set(...auth(owner.accessToken))
      .send({ legalName, idempotencyKey: randomUUID() })
      .expect(201);
    Object.assign(owner, await refresh(owner.refreshToken));
    return body(res).organizationId as string;
  }

  async function ownerWithOrganization(): Promise<{ owner: Owner; organizationId: string }> {
    const owner = await customer();
    return { owner, organizationId: await applyFor(owner) };
  }

  const submit = (token: string, payload: Record<string, unknown>) =>
    request(ctx.server).post('/verification/documents').set(...auth(token)).send(payload);

  async function submitLicence(owner: Owner, organizationId: string): Promise<string> {
    const res = await submit(owner.accessToken, { type: 'PHARMACY_LICENSE', organizationId, documents: LICENCE_DOCS }).expect(202);
    return body(res).requestId as string;
  }

  const approve = (requestId: string, payload: Record<string, unknown>, token = admin.accessToken) =>
    request(ctx.server).post(`/admin/verification/${requestId}/approve`).set(...auth(token)).send(payload);

  const reject = (requestId: string, reason = 'Licence photo is unreadable') =>
    request(ctx.server).post(`/admin/verification/${requestId}/reject`).set(...auth(admin.accessToken)).send({ reason });

  const licence = (licenseNumber: string, expiresAt: Date) => ({ licenseNumber, expiresAt: expiresAt.toISOString() });

  async function approvedOwner(expiresAt = new Date(Date.now() + 365 * DAY), licenseNumber = 'EFDA/PH/0001') {
    const { owner, organizationId } = await ownerWithOrganization();
    const requestId = await submitLicence(owner, organizationId);
    await approve(requestId, licence(licenseNumber, expiresAt)).expect(204);
    return { owner, organizationId, requestId, expiresAt, licenseNumber };
  }

  async function registerPharmacy(owner: Owner, organizationId: string): Promise<string> {
    const res = await request(ctx.server)
      .post('/pharmacy/register')
      .set(...auth(owner.accessToken))
      .send({ organizationId, displayName: 'Abebe Pharmacy' })
      .expect(201);
    return body(res).pharmacyId as string;
  }

  const activate = (pharmacyId: string) =>
    request(ctx.server).post('/pharmacy/activate').set(...auth(admin.accessToken)).send({ pharmacyId });

  const organization = (id: string) => ctx.prisma.organization.findUniqueOrThrow({ where: { id } });
  const verification = (id: string) => ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id } });
  const pharmacyRow = (id: string) => ctx.prisma.pharmacy.findUniqueOrThrow({ where: { id } });
  const expire = (now: Date) => ctx.app.get(ExpireVerificationsCommand).execute(now);
  const activations = async (pharmacyId: string) => ({
    audits: await ctx.prisma.auditLog.count({ where: { action: 'PHARMACY_ACTIVATED', resourceId: pharmacyId } }),
    events: await ctx.prisma.outbox.count({
      where: { eventType: PharmacyInventoryEventType.PharmacyActivated, aggregateId: pharmacyId },
    }),
  });

  function refusal(res: request.Response): { code: string; reason?: string } {
    const error = (res.body as { error: { code: string; details?: { reason?: string } } }).error;
    return { code: error.code, reason: error.details?.reason };
  }

  /** Seeds a pharmacy row directly for organisations no owner flow can produce (e.g. a HOSPITAL). */
  async function seedPharmacy(organizationId: string): Promise<string> {
    const row = await ctx.prisma.pharmacy.create({ data: { organizationId, displayName: 'Seeded' } });
    return row.id;
  }

  // -------------------------------------------------------------------------------------------
  // Submission ownership
  // -------------------------------------------------------------------------------------------

  describe('submission', () => {
    it('1. accepts pharmacy licence documents for the owner’s own pharmacy organisation', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const requestId = await submitLicence(owner, organizationId);
      expect(await verification(requestId)).toMatchObject({
        userId: owner.userId,
        organizationId,
        type: 'PHARMACY_LICENSE',
        status: 'PENDING',
        licenseNumber: null,
      });
    });

    it('2. refuses another owner’s organisation, without revealing that it exists', async () => {
      const { organizationId } = await ownerWithOrganization();
      const intruder = await customer();
      const res = await submit(intruder.accessToken, { type: 'PHARMACY_LICENSE', organizationId, documents: LICENCE_DOCS }).expect(404);
      expect(errorOf(res).code).toBe('NOT_FOUND');
      expect(await ctx.prisma.verificationRequest.count()).toBe(0);
    });

    it('3. refuses a pharmacy licence for the caller’s own non-pharmacy organisation', async () => {
      const owner = await customer();
      for (const type of ['HOSPITAL', 'CLINIC', 'LAB'] as const) {
        const org = await ctx.prisma.organization.create({ data: { type, name: `${type} org`, ownerUserId: owner.userId } });
        const res = await submit(owner.accessToken, { type: 'PHARMACY_LICENSE', organizationId: org.id, documents: LICENCE_DOCS }).expect(422);
        expect(refusal(res)).toEqual({ code: 'BUSINESS_RULE_VIOLATION', reason: 'ORGANIZATION_NOT_PHARMACY' });
      }
      expect(await ctx.prisma.verificationRequest.count()).toBe(0);
    });

    it('4. requires organizationId for a pharmacy licence', async () => {
      const { owner } = await ownerWithOrganization();
      const res = await submit(owner.accessToken, { type: 'PHARMACY_LICENSE', documents: LICENCE_DOCS }).expect(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(await ctx.prisma.verificationRequest.count()).toBe(0);
    });

    it('5–6. appends to the same organisation’s request only; one owner keeps two independent applications', async () => {
      const owner = await customer();
      const first = await applyFor(owner, 'First Pharmacy');
      const second = await applyFor(owner, 'Second Pharmacy');

      const a1 = await submitLicence(owner, first);
      const b1 = await submitLicence(owner, second);
      const a2 = await submitLicence(owner, first);
      expect(a2).toBe(a1);
      expect(b1).not.toBe(a1);

      expect((await verification(a1)).documents).toHaveLength(2);
      expect((await verification(b1)).documents).toHaveLength(1);
      expect(await verification(b1)).toMatchObject({ organizationId: second, status: 'PENDING' });

      // Each application is decided on its own.
      await approve(a1, licence('LIC-A', new Date(Date.now() + 100 * DAY))).expect(204);
      await reject(b1).expect(204);
      expect(await organization(first)).toMatchObject({ status: 'ACTIVE', licenseNumber: 'LIC-A' });
      expect(await organization(second)).toMatchObject({ status: 'REJECTED', licenseNumber: null });
    });

    it('7. concurrent submissions converge on one pending request with every document', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          submit(owner.accessToken, {
            type: 'PHARMACY_LICENSE',
            organizationId,
            documents: [{ kind: 'PHARMACY_LICENSE', storageRef: `enc://verification/doc-${i}` }],
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(202));
      expect(new Set(results.map((r) => body(r).requestId)).size).toBe(1);
      const rows = await ctx.prisma.verificationRequest.findMany({ where: { organizationId, status: 'PENDING' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].documents).toHaveLength(6);
    });

    it('8. keeps the per-(user, type) behaviour for other verification types', async () => {
      const registered = await registerAndVerify(ctx);
      const user = { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
      const docs = [{ kind: 'DRIVING_LICENSE', storageRef: 'enc://verification/drv-1' }];
      const first = body(await submit(user.accessToken, { type: 'DRIVER_DOCS', documents: docs }).expect(202));
      const second = body(await submit(user.accessToken, { type: 'DRIVER_DOCS', documents: docs }).expect(202));
      expect(second.requestId).toBe(first.requestId);
      expect(second.documentCount).toBe(2);
      expect(await verification(first.requestId as string)).toMatchObject({ organizationId: null, licenseNumber: null });
    });
  });

  // -------------------------------------------------------------------------------------------
  // Approval
  // -------------------------------------------------------------------------------------------

  describe('approval', () => {
    it('9–11. approves the request and activates the organisation with the same licence; the pharmacy stays PENDING', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const pharmacyId = await registerPharmacy(owner, organizationId);
      const requestId = await submitLicence(owner, organizationId);
      const expiresAt = new Date(Date.now() + 365 * DAY);

      await approve(requestId, licence('  EFDA/PH/0042  ', expiresAt)).expect(204);

      expect(await verification(requestId)).toMatchObject({
        status: 'APPROVED',
        reviewerId: admin.userId,
        licenseNumber: 'EFDA/PH/0042',
        expiresAt,
      });
      expect(await organization(organizationId)).toMatchObject({
        status: 'ACTIVE',
        licenseNumber: 'EFDA/PH/0042',
        licenseExpiresAt: expiresAt,
      });
      expect(await pharmacyRow(pharmacyId)).toMatchObject({ transactingStatus: 'PENDING' });
      expect(await activations(pharmacyId)).toEqual({ audits: 0, events: 0 });

      const events = await ctx.prisma.outbox.findMany({ where: { eventType: IdentityEventType.ProviderApproved } });
      expect(events).toHaveLength(1);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'identity.organization.license_approved', resourceId: organizationId } })).toBe(1);
    });

    it('9. the Module 16 admin surface approves with the licence too', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const requestId = await submitLicence(owner, organizationId);
      const res = await request(ctx.server)
        .post(`/admin/verifications/${requestId}/approve`)
        .set(...auth(admin.accessToken))
        .send(licence('LIC-M16', new Date(Date.now() + 30 * DAY)))
        .expect(200);
      expect(body(res)).toMatchObject({ status: 'APPROVED', licenseNumber: 'LIC-M16' });
      expect(await organization(organizationId)).toMatchObject({ status: 'ACTIVE', licenseNumber: 'LIC-M16' });

      const detail = body(await request(ctx.server).get(`/admin/verifications/${requestId}`).set(...auth(admin.accessToken)).expect(200));
      expect(detail).toMatchObject({ organizationId, licenseNumber: 'LIC-M16', documents: [{ kind: 'PHARMACY_LICENSE', storageRef: 'enc://verification/licence-1' }] });
      expect(JSON.stringify(detail)).not.toMatch(/faydaIdEncrypted|passwordHash|mfa/i);
    });

    it('12–13. refuses a missing, blank or oversized licence number and a missing or non-future expiry', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const requestId = await submitLicence(owner, organizationId);
      const future = new Date(Date.now() + 30 * DAY).toISOString();
      for (const payload of [
        { expiresAt: future },
        { licenseNumber: '   ', expiresAt: future },
        { licenseNumber: 'X'.repeat(65), expiresAt: future },
        { licenseNumber: 'LIC-1' },
        { licenseNumber: 'LIC-1', expiresAt: new Date(Date.now() - 1000).toISOString() },
        { licenseNumber: 'LIC-1', expiresAt: 'not-a-date' },
      ]) {
        const res = await approve(requestId, payload).expect(400);
        expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      }
      expect(await verification(requestId)).toMatchObject({ status: 'PENDING', licenseNumber: null });
      expect(await organization(organizationId)).toMatchObject({ status: 'PENDING_APPROVAL', licenseNumber: null });
    });

    it('14–15. refuses a request with no organisation, another owner’s, or a non-pharmacy organisation', async () => {
      const subject = await customer();
      const other = await customer();
      const othersOrg = await ctx.prisma.organization.create({ data: { type: 'PHARMACY', name: 'Other', ownerUserId: other.userId } });
      const clinic = await ctx.prisma.organization.create({ data: { type: 'CLINIC', name: 'Clinic', ownerUserId: subject.userId } });
      // Requests that could only predate Work 67's submission rules, seeded as Module 01 rows.
      for (const [organizationId, reason] of [
        [null, 'ORGANIZATION_MISSING'],
        [othersOrg.id, 'OWNER_MISMATCH'],
        [clinic.id, 'ORGANIZATION_NOT_PHARMACY'],
      ] as const) {
        const seeded = await ctx.prisma.verificationRequest.create({
          data: { userId: subject.userId, organizationId, type: 'PHARMACY_LICENSE', documents: LICENCE_DOCS },
        });
        const res = await approve(seeded.id, licence('LIC-1', new Date(Date.now() + 30 * DAY))).expect(422);
        expect(refusal(res)).toEqual({ code: 'BUSINESS_RULE_VIOLATION', reason });
        expect(await verification(seeded.id)).toMatchObject({ status: 'PENDING', licenseNumber: null });
      }
      expect(await organization(othersOrg.id)).toMatchObject({ status: 'PENDING_APPROVAL', licenseNumber: null });
    });

    it('16. two administrators approving at once produce one decision', async () => {
      const second = await createUserWithRole(ctx, 'ADMIN');
      const { owner, organizationId } = await ownerWithOrganization();
      const requestId = await submitLicence(owner, organizationId);
      const results = await Promise.all([
        approve(requestId, licence('LIC-FIRST', new Date(Date.now() + 10 * DAY))),
        approve(requestId, licence('LIC-SECOND', new Date(Date.now() + 20 * DAY)), second.accessToken),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 422]);
      const stored = await verification(requestId);
      const org = await organization(organizationId);
      expect(org.licenseNumber).toBe(stored.licenseNumber);
      expect(org.licenseExpiresAt).toEqual(stored.expiresAt);
      expect(await ctx.prisma.outbox.count({ where: { eventType: IdentityEventType.ProviderApproved } })).toBe(1);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'identity.organization.license_approved' } })).toBe(1);
    });

    it('17. a failure inside the approval transaction leaves request, organisation, user, audit and outbox unchanged', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const requestId = await submitLicence(owner, organizationId);
      const userBefore = await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
      const auditsBefore = await ctx.prisma.auditLog.count();
      const outboxBefore = await ctx.prisma.outbox.count();

      failing.failNext = true;
      await approve(requestId, licence('LIC-1', new Date(Date.now() + 30 * DAY))).expect(500);

      expect(await verification(requestId)).toMatchObject({ status: 'PENDING', licenseNumber: null, expiresAt: null, reviewerId: null });
      expect(await organization(organizationId)).toMatchObject({ status: 'PENDING_APPROVAL', licenseNumber: null, licenseExpiresAt: null });
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })).toMatchObject({ status: userBefore.status });
      expect(await ctx.prisma.auditLog.count()).toBe(auditsBefore);
      expect(await ctx.prisma.outbox.count()).toBe(outboxBefore);

      // And the same request can still be approved.
      await approve(requestId, licence('LIC-1', new Date(Date.now() + 30 * DAY))).expect(204);
      expect(await organization(organizationId)).toMatchObject({ status: 'ACTIVE' });
    });

    it('18. DRIVER_DOCS and DOCTOR_LICENSE approvals need no pharmacy licence fields', async () => {
      for (const type of ['DRIVER_DOCS', 'DOCTOR_LICENSE']) {
        const registered = await registerAndVerify(ctx);
        const user = { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
        const requestId = body(
          await submit(user.accessToken, { type, documents: [{ kind: 'LICENCE', storageRef: 'enc://verification/x' }] }).expect(202),
        ).requestId as string;
        await approve(requestId, {}).expect(204);
        expect(await verification(requestId)).toMatchObject({ status: 'APPROVED', licenseNumber: null });
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // Rejection and expiry
  // -------------------------------------------------------------------------------------------

  describe('rejection and expiry', () => {
    it('19. rejecting an initial application rejects the pending organisation', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const requestId = await submitLicence(owner, organizationId);
      await reject(requestId).expect(204);
      expect(await verification(requestId)).toMatchObject({ status: 'REJECTED', rejectReason: 'Licence photo is unreadable' });
      expect(await organization(organizationId)).toMatchObject({ status: 'REJECTED', licenseNumber: null, licenseExpiresAt: null });

      // The owner may correct and resubmit; approval then activates the organisation.
      const again = await submitLicence(owner, organizationId);
      expect(again).not.toBe(requestId);
      await approve(again, licence('LIC-2', new Date(Date.now() + 30 * DAY))).expect(204);
      expect(await organization(organizationId)).toMatchObject({ status: 'ACTIVE', licenseNumber: 'LIC-2' });
    });

    it('20. rejecting a renewal keeps the current valid licence and status', async () => {
      const { owner, organizationId, expiresAt } = await approvedOwner();
      const renewal = await submitLicence(owner, organizationId);
      await reject(renewal).expect(204);
      expect(await organization(organizationId)).toMatchObject({
        status: 'ACTIVE',
        licenseNumber: 'EFDA/PH/0001',
        licenseExpiresAt: expiresAt,
      });
    });

    it('21. expiry of an older, superseded licence leaves the renewed organisation ACTIVE', async () => {
      const first = new Date(Date.now() + DAY);
      const { owner, organizationId, requestId: old } = await approvedOwner(first, 'LIC-OLD');
      const renewed = new Date(Date.now() + 2 * DAY);
      const renewal = await submitLicence(owner, organizationId);
      await approve(renewal, licence('LIC-NEW', renewed)).expect(204);

      expect(await expire(new Date(first.getTime() + 1000))).toBe(1);
      expect(await verification(old)).toMatchObject({ status: 'EXPIRED' });
      expect(await verification(renewal)).toMatchObject({ status: 'APPROVED' });
      expect(await organization(organizationId)).toMatchObject({ status: 'ACTIVE', licenseNumber: 'LIC-NEW', licenseExpiresAt: renewed });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'identity.license.expired_without_suspension' } })).toBe(1);
    });

    it('22. expiry of the current licence suspends the organisation, and the pharmacy can no longer transact', async () => {
      const expiresAt = new Date(Date.now() + DAY);
      const { owner, organizationId, requestId } = await approvedOwner(expiresAt);
      const pharmacyId = await registerPharmacy(owner, organizationId);
      await activate(pharmacyId).expect(201);

      const later = new Date(expiresAt.getTime() + 1000);
      expect(await expire(later)).toBe(1);
      expect(await verification(requestId)).toMatchObject({ status: 'EXPIRED' });
      expect(await organization(organizationId)).toMatchObject({ status: 'SUSPENDED' });
      expect(await ctx.prisma.outbox.count({ where: { eventType: IdentityEventType.LicenseExpired } })).toBe(1);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'identity.organization.suspended_license_expired', resourceId: organizationId } })).toBe(1);

      // Module 04: the pharmacy's copied expiry has passed, so it is not eligible at that time.
      const row = await pharmacyRow(pharmacyId);
      expect(row.licenseExpiresAt).toEqual(expiresAt);
      expect(TransactingEligibilityPolicy.isEligible(row, later)).toBe(false);
    });

    it('23. one organisation’s expiry neither suspends the owner nor their other organisation', async () => {
      const owner = await customer();
      const soon = new Date(Date.now() + DAY);
      const later = new Date(Date.now() + 90 * DAY);
      const first = await applyFor(owner, 'First');
      const second = await applyFor(owner, 'Second');
      await approve(await submitLicence(owner, first), licence('LIC-1', soon)).expect(204);
      await approve(await submitLicence(owner, second), licence('LIC-2', later)).expect(204);

      expect(await expire(new Date(soon.getTime() + 1000))).toBe(1);
      expect(await organization(first)).toMatchObject({ status: 'SUSPENDED' });
      expect(await organization(second)).toMatchObject({ status: 'ACTIVE' });
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })).toMatchObject({ status: 'ACTIVE' });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'identity.account.suspended' } })).toBe(0);
    });

    it('24. a licence expiring exactly now is expired', async () => {
      const expiresAt = new Date(Date.now() + DAY);
      const { organizationId, requestId } = await approvedOwner(expiresAt);
      expect(await expire(new Date(expiresAt.getTime() - 1))).toBe(0);
      expect(await expire(expiresAt)).toBe(1);
      expect(await verification(requestId)).toMatchObject({ status: 'EXPIRED' });
      expect(await organization(organizationId)).toMatchObject({ status: 'SUSPENDED' });
    });
  });

  // -------------------------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------------------------

  describe('activation', () => {
    it('25. refuses while the organisation is PENDING_APPROVAL', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const pharmacyId = await registerPharmacy(owner, organizationId);
      await submitLicence(owner, organizationId);
      const res = await activate(pharmacyId).expect(403);
      expect(refusal(res)).toEqual({ code: 'PHARMACY_NOT_ELIGIBLE', reason: 'ORGANIZATION_NOT_ACTIVE' });
      expect(await pharmacyRow(pharmacyId)).toMatchObject({ transactingStatus: 'PENDING', licenseExpiresAt: null });
      expect(await activations(pharmacyId)).toEqual({ audits: 0, events: 0 });
    });

    it('26. refuses while the organisation is REJECTED or SUSPENDED', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const pharmacyId = await registerPharmacy(owner, organizationId);
      await reject(await submitLicence(owner, organizationId)).expect(204);
      expect(refusal(await activate(pharmacyId).expect(403)).reason).toBe('ORGANIZATION_NOT_ACTIVE');

      const expiresAt = new Date(Date.now() + DAY);
      const approved = await approvedOwner(expiresAt);
      const otherPharmacy = await registerPharmacy(approved.owner, approved.organizationId);
      await expire(new Date(expiresAt.getTime() + 1000));
      expect(refusal(await activate(otherPharmacy).expect(403)).reason).toBe('ORGANIZATION_NOT_ACTIVE');
      expect(await activations(pharmacyId)).toEqual({ audits: 0, events: 0 });
      expect(await activations(otherPharmacy)).toEqual({ audits: 0, events: 0 });
    });

    it('27–28. refuses an organisation whose licence has no approved request (none, pending or rejected)', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const pharmacyId = await registerPharmacy(owner, organizationId);
      const expiresAt = new Date(Date.now() + 30 * DAY);
      // Organisation metadata set without any approval (test-only seeding of Module 01 state).
      await ctx.prisma.organization.update({
        where: { id: organizationId },
        data: { status: 'ACTIVE', licenseNumber: 'LIC-X', licenseExpiresAt: expiresAt },
      });
      expect(refusal(await activate(pharmacyId).expect(403)).reason).toBe('LICENSE_NOT_APPROVED');

      const requestId = await submitLicence(owner, organizationId);
      await ctx.prisma.verificationRequest.update({ where: { id: requestId }, data: { licenseNumber: 'LIC-X', expiresAt } });
      expect(refusal(await activate(pharmacyId).expect(403)).reason).toBe('LICENSE_NOT_APPROVED');

      await ctx.prisma.verificationRequest.update({ where: { id: requestId }, data: { status: 'REJECTED', reviewerId: admin.userId } });
      expect(refusal(await activate(pharmacyId).expect(403)).reason).toBe('LICENSE_NOT_APPROVED');
      expect(await activations(pharmacyId)).toEqual({ audits: 0, events: 0 });
    });

    it('29. refuses an expired or missing licence expiry', async () => {
      const { owner, organizationId } = await approvedOwner();
      const pharmacyId = await registerPharmacy(owner, organizationId);

      await ctx.prisma.organization.update({ where: { id: organizationId }, data: { licenseExpiresAt: new Date(Date.now() - 1000) } });
      expect(errorOf(await activate(pharmacyId).expect(403)).code).toBe('LICENSE_EXPIRED');

      await ctx.prisma.organization.update({ where: { id: organizationId }, data: { licenseExpiresAt: null } });
      expect(refusal(await activate(pharmacyId).expect(403)).reason).toBe('LICENSE_MISSING');
      expect(await activations(pharmacyId)).toEqual({ audits: 0, events: 0 });
    });

    it('30. refuses when the organisation’s licence differs from the approved request', async () => {
      const { owner, organizationId, expiresAt } = await approvedOwner();
      const pharmacyId = await registerPharmacy(owner, organizationId);

      await ctx.prisma.organization.update({ where: { id: organizationId }, data: { licenseNumber: 'TAMPERED' } });
      expect(refusal(await activate(pharmacyId).expect(403)).reason).toBe('LICENSE_NOT_APPROVED');

      await ctx.prisma.organization.update({
        where: { id: organizationId },
        data: { licenseNumber: 'EFDA/PH/0001', licenseExpiresAt: new Date(expiresAt.getTime() + DAY) },
      });
      expect(refusal(await activate(pharmacyId).expect(403)).reason).toBe('LICENSE_NOT_APPROVED');
      expect(await activations(pharmacyId)).toEqual({ audits: 0, events: 0 });
    });

    it('31. refuses a pharmacy attached to another organisation type', async () => {
      const owner = await customer();
      const hospital = await ctx.prisma.organization.create({
        data: { type: 'HOSPITAL', name: 'Hospital', status: 'ACTIVE', ownerUserId: owner.userId, licenseNumber: 'H-1', licenseExpiresAt: new Date(Date.now() + DAY) },
      });
      const pharmacyId = await seedPharmacy(hospital.id);
      expect(refusal(await activate(pharmacyId).expect(403)).reason).toBe('ORGANIZATION_NOT_PHARMACY');
      expect(await activations(pharmacyId)).toEqual({ audits: 0, events: 0 });
    });

    it('32–35. activates on approved evidence, copies the expiry, and emits exactly once even when repeated', async () => {
      const { owner, organizationId, requestId, expiresAt } = await approvedOwner();
      const pharmacyId = await registerPharmacy(owner, organizationId);

      const results = await Promise.all([activate(pharmacyId), activate(pharmacyId), activate(pharmacyId)]);
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      await activate(pharmacyId).expect(201);

      expect(await pharmacyRow(pharmacyId)).toMatchObject({
        transactingStatus: 'ACTIVE',
        licenseStatus: 'VALID',
        licenseExpiresAt: expiresAt,
      });
      expect(await activations(pharmacyId)).toEqual({ audits: 1, events: 1 });
      const entry = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'PHARMACY_ACTIVATED', resourceId: pharmacyId } });
      expect(entry.context).toMatchObject({ organizationId, verificationRequestId: requestId });
    });

    it('36. a suspended pharmacy is restored by explicit activation after a newer licence is approved', async () => {
      const expiresAt = new Date(Date.now() + DAY);
      const { owner, organizationId } = await approvedOwner(expiresAt, 'LIC-OLD');
      const pharmacyId = await registerPharmacy(owner, organizationId);
      await activate(pharmacyId).expect(201);

      await expire(new Date(expiresAt.getTime() + 1000));
      // Module 04's own sweeper runs on the real clock: put the copied expiry in its past, then run it.
      await ctx.prisma.pharmacy.update({ where: { id: pharmacyId }, data: { licenseExpiresAt: new Date(Date.now() - 1000) } });
      expect(await ctx.app.get(LicenseExpirySweeper).run()).toBe(1);
      expect(await pharmacyRow(pharmacyId)).toMatchObject({ transactingStatus: 'SUSPENDED', licenseStatus: 'EXPIRED' });
      expect(refusal(await activate(pharmacyId).expect(403)).reason).toBe('ORGANIZATION_NOT_ACTIVE');

      const renewed = new Date(Date.now() + 400 * DAY);
      await approve(await submitLicence(owner, organizationId), licence('LIC-NEW', renewed)).expect(204);
      expect(await organization(organizationId)).toMatchObject({ status: 'ACTIVE', licenseNumber: 'LIC-NEW' });
      expect(await pharmacyRow(pharmacyId)).toMatchObject({ transactingStatus: 'SUSPENDED' });

      await activate(pharmacyId).expect(201);
      expect(await pharmacyRow(pharmacyId)).toMatchObject({ transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: renewed });
      expect(await activations(pharmacyId)).toEqual({ audits: 2, events: 2 });
    });

    it('accepts nothing about the licence from the request body', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const pharmacyId = await registerPharmacy(owner, organizationId);
      const res = await request(ctx.server)
        .post('/pharmacy/activate')
        .set(...auth(admin.accessToken))
        .send({ pharmacyId, licenseNumber: 'LIC-1', licenseExpiresAt: new Date(Date.now() + DAY).toISOString(), status: 'ACTIVE' })
        .expect(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(await pharmacyRow(pharmacyId)).toMatchObject({ transactingStatus: 'PENDING' });
    });

    it('is not available to the owner', async () => {
      const { owner, organizationId } = await approvedOwner();
      const pharmacyId = await registerPharmacy(owner, organizationId);
      await request(ctx.server).post('/pharmacy/activate').set(...auth(owner.accessToken)).send({ pharmacyId }).expect(403);
      expect(await pharmacyRow(pharmacyId)).toMatchObject({ transactingStatus: 'PENDING' });
    });
  });

  // -------------------------------------------------------------------------------------------
  // Regression
  // -------------------------------------------------------------------------------------------

  describe('regression', () => {
    it('37. registration still creates a PENDING pharmacy, before and after licence approval', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const pharmacyId = await registerPharmacy(owner, organizationId);
      expect(await pharmacyRow(pharmacyId)).toMatchObject({ transactingStatus: 'PENDING' });
      await approve(await submitLicence(owner, organizationId), licence('LIC-1', new Date(Date.now() + 30 * DAY))).expect(204);
      expect(await pharmacyRow(pharmacyId)).toMatchObject({ transactingStatus: 'PENDING' });
    });

    it('40. pending and suspended pharmacies stay ineligible under Module 04’s policy', async () => {
      const { owner, organizationId } = await approvedOwner();
      const pharmacyId = await registerPharmacy(owner, organizationId);
      expect(TransactingEligibilityPolicy.isEligible(await pharmacyRow(pharmacyId))).toBe(false);
      await activate(pharmacyId).expect(201);
      expect(TransactingEligibilityPolicy.isEligible(await pharmacyRow(pharmacyId))).toBe(true);
      await ctx.prisma.pharmacy.update({ where: { id: pharmacyId }, data: { transactingStatus: 'SUSPENDED', licenseStatus: 'EXPIRED' } });
      expect(TransactingEligibilityPolicy.isEligible(await pharmacyRow(pharmacyId))).toBe(false);
    });
  });
});
