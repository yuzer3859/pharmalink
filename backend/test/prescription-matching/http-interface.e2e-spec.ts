import request from 'supertest';
import { AssignVerifyingPharmacyCommand } from '../../src/modules/prescription-matching/application/commands/assign-verifying-pharmacy.command';
import {
  auth,
  body,
  createUserWithRole,
  errorOf,
  login,
  registerAndVerify,
} from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, grantOrgRole } from '../pharmacy-inventory/support';

/**
 * Module 05 HTTP interface layer (Task 8, module-05 §10) — exercises the real NestJS
 * controller/guard/filter pipeline end-to-end (real `AppModule`, real Postgres, real
 * `PermissionsGuard`/`AllExceptionsFilter`), mirroring Module 04's own
 * `access-control.e2e-spec.ts` conventions. `AssignVerifyingPharmacyCommand` has no HTTP route
 * (§4/§7.3 — an internal port method Module 06 will call in the future), so verification-flow
 * tests resolve it directly via Nest DI to set up the `PENDING_VERIFICATION` precondition, the
 * same way a future Module 06 checkout saga would.
 */
describe('Prescription & Matching — HTTP interface (e2e)', () => {
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

  async function customerTokens() {
    const customer = await registerAndVerify(ctx);
    const tokens = await login(ctx, customer.phone, customer.password);
    return { ...customer, ...tokens };
  }

  async function activeCatalogProduct(rxClassification: 'RX' | 'OTC' = 'OTC'): Promise<string> {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const mfr = body(
      await request(ctx.server)
        .post('/admin/catalog/manufacturers')
        .set(...auth(admin.accessToken))
        .send({ name: 'Acme Pharma' })
        .expect(201),
    );
    const product = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(admin.accessToken))
        .send({
          type: 'MEDICINE',
          genericName: 'Ibuprofen',
          manufacturerId: mfr.id,
          dosageForm: 'TABLET',
          strengthValue: 400,
          strengthUnit: 'MG',
          rxClassification,
          nameEn: 'Ibuprofen 400mg',
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

  async function createListing(
    pharmacy: Awaited<ReturnType<typeof createActivatedPharmacy>>,
    catalogProductId: string,
    quantity: number,
  ): Promise<{ branchId: string; listingId: string }> {
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );
    const listing = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId,
          branchId: branch.branchId,
          price: 300,
          batchNumber: 'B-1',
          initialQuantity: quantity,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    return { branchId: branch.branchId as string, listingId: listing.listingId as string };
  }

  async function assignToVerifyingPharmacy(prescriptionId: string, organizationId: string): Promise<void> {
    const assign = ctx.app.get(AssignVerifyingPharmacyCommand);
    await assign.execute({ prescriptionId, pharmacyId: organizationId });
  }

  describe('Authentication', () => {
    it('rejects an unauthenticated upload with 401', async () => {
      const res = await request(ctx.server)
        .post('/prescriptions')
        .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' });
      expect(res.status).toBe(401);
    });

    it('an authenticated request with a valid token reaches the controller/application layer', async () => {
      const customer = await customerTokens();
      const res = await request(ctx.server)
        .post('/prescriptions')
        .set(...auth(customer.accessToken))
        .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' });
      expect(res.status).toBe(201);
    });
  });

  describe('RBAC', () => {
    it('a permitted role (CUSTOMER, auto-granted prescription:upload:own) can upload', async () => {
      const customer = await customerTokens();
      const res = await request(ctx.server)
        .post('/prescriptions')
        .set(...auth(customer.accessToken))
        .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' });
      expect(res.status).toBe(201);
      expect(body(res)).toMatchObject({ status: 'UPLOADED' });
    });

    it('a role without prescription:upload:own is rejected with 403 FORBIDDEN', async () => {
      // Registration always auto-grants CUSTOMER (module-05's own permissions, §7.2, are all
      // CUSTOMER-scoped) — so exercising a real "missing permission" case requires a principal
      // whose only role grants none of them. Strip the auto-granted CUSTOMER role (leaving only
      // PHARMACY_OWNER, which has no prescription:* permission) *before* logging in, since the
      // access token snapshots the effective permission set at issuance (JwtAuthGuard).
      const registered = await registerAndVerify(ctx);
      const customerRole = await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'CUSTOMER' } });
      await ctx.prisma.userRole.deleteMany({
        where: { userId: registered.userId, roleId: customerRole.id },
      });
      const ownerRole = await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'PHARMACY_OWNER' } });
      await ctx.prisma.userRole.create({
        data: { userId: registered.userId, roleId: ownerRole.id, organizationId: null },
      });
      const tokens = await login(ctx, registered.phone, registered.password);

      const res = await request(ctx.server)
        .post('/prescriptions')
        .set(...auth(tokens.accessToken))
        .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' });
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    });

    it('a customer without prescription:verify cannot reach the verification queue', async () => {
      const customer = await customerTokens();
      const res = await request(ctx.server)
        .get('/pharmacy/verification/queue')
        .set(...auth(customer.accessToken));
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    });
  });

  describe('Prescription endpoints (customer)', () => {
    it('valid upload returns 201 with prescriptionId and status UPLOADED', async () => {
      const customer = await customerTokens();
      const res = await request(ctx.server)
        .post('/prescriptions')
        .set(...auth(customer.accessToken))
        .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' });
      expect(res.status).toBe(201);
      expect(body(res)).toMatchObject({ status: 'UPLOADED' });
      expect(typeof body(res).id).toBe('string');
    });

    it('rejects an invalid DTO (unsupported fileType) with 400 VALIDATION_ERROR', async () => {
      const customer = await customerTokens();
      const res = await request(ctx.server)
        .post('/prescriptions')
        .set(...auth(customer.accessToken))
        .send({ fileRef: 'file-ref-1', fileType: 'text/plain' });
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    });

    it('rejects a missing required field (fileRef) with 400 VALIDATION_ERROR', async () => {
      const customer = await customerTokens();
      const res = await request(ctx.server)
        .post('/prescriptions')
        .set(...auth(customer.accessToken))
        .send({ fileType: 'application/pdf' });
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    });

    it('retrieves the caller\'s own prescription by id, including the derived displayStatus', async () => {
      const customer = await customerTokens();
      const uploaded = body(
        await request(ctx.server)
          .post('/prescriptions')
          .set(...auth(customer.accessToken))
          .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' })
          .expect(201),
      );
      const res = body(
        await request(ctx.server)
          .get(`/prescriptions/${uploaded.id as string}`)
          .set(...auth(customer.accessToken))
          .expect(200),
      );
      expect(res).toMatchObject({ id: uploaded.id, status: 'UPLOADED', displayStatus: 'UPLOADED' });
    });

    it('lists only the caller\'s own prescriptions, paginated', async () => {
      const customer = await customerTokens();
      await request(ctx.server)
        .post('/prescriptions')
        .set(...auth(customer.accessToken))
        .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' })
        .expect(201);
      await request(ctx.server)
        .post('/prescriptions')
        .set(...auth(customer.accessToken))
        .send({ fileRef: 'file-ref-2', fileType: 'application/pdf' })
        .expect(201);

      const other = await customerTokens();
      await request(ctx.server)
        .post('/prescriptions')
        .set(...auth(other.accessToken))
        .send({ fileRef: 'file-ref-3', fileType: 'application/pdf' })
        .expect(201);

      const res = body(
        await request(ctx.server)
          .get('/prescriptions')
          .set(...auth(customer.accessToken))
          .expect(200),
      ) as unknown as { items: unknown[]; total: number };
      expect(res.total).toBe(2);
      expect(res.items).toHaveLength(2);
    });

    it('a stranger cannot read another customer\'s prescription — 404, not a data leak', async () => {
      const owner = await customerTokens();
      const uploaded = body(
        await request(ctx.server)
          .post('/prescriptions')
          .set(...auth(owner.accessToken))
          .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' })
          .expect(201),
      );

      const stranger = await customerTokens();
      const res = await request(ctx.server)
        .get(`/prescriptions/${uploaded.id as string}`)
        .set(...auth(stranger.accessToken));
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PRESCRIPTION_NOT_FOUND');

      // The denial itself was logged (FR-REC-06), even though it never reached the customer.
      const logs = await ctx.prisma.prescriptionAccessLog.findMany({
        where: { prescriptionId: uploaded.id as string },
      });
      expect(logs.some((l) => l.outcome === 'DENY')).toBe(true);
    });

    it('GET /prescriptions/:id for a non-existent id returns 404 PRESCRIPTION_NOT_FOUND', async () => {
      const customer = await customerTokens();
      const res = await request(ctx.server)
        .get('/prescriptions/00000000-0000-0000-0000-000000000000')
        .set(...auth(customer.accessToken));
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PRESCRIPTION_NOT_FOUND');
    });
  });

  describe('Verification endpoints (pharmacist)', () => {
    it('an authorized reviewer at the correct pharmacy can approve, listing appearing in their own queue first', async () => {
      const customer = await customerTokens();
      const pharmacy = await createActivatedPharmacy(ctx);
      const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);
      const productId = await activeCatalogProduct();

      const uploaded = body(
        await request(ctx.server)
          .post('/prescriptions')
          .set(...auth(customer.accessToken))
          .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' })
          .expect(201),
      );
      await assignToVerifyingPharmacy(uploaded.id as string, pharmacy.organizationId);

      const queue = body(
        await request(ctx.server)
          .get('/pharmacy/verification/queue')
          .set(...auth(pharmacist.accessToken))
          .expect(200),
      ) as unknown as { items: Array<{ id: string }>; total: number };
      expect(queue.items.map((i) => i.id)).toContain(uploaded.id);

      const approved = body(
        await request(ctx.server)
          .post(`/pharmacy/verification/${uploaded.id as string}/approve`)
          .set(...auth(pharmacist.accessToken))
          .send({
            lines: [{ catalogProductId: productId, approvedQuantity: 10, refillsAllowed: 0, isSingleUse: false }],
            legibilityOk: true,
            validityOk: true,
          })
          .expect(200),
      );
      expect(approved.status).toBe('APPROVED');
    });

    it('a reviewer at the wrong organization is rejected with 403 VERIFICATION_FORBIDDEN', async () => {
      const customer = await customerTokens();
      const pharmacy = await createActivatedPharmacy(ctx);
      const otherPharmacy = await createActivatedPharmacy(ctx);
      const wrongPharmacist = await grantOrgRole(ctx, 'PHARMACIST', otherPharmacy.organizationId);

      const uploaded = body(
        await request(ctx.server)
          .post('/prescriptions')
          .set(...auth(customer.accessToken))
          .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' })
          .expect(201),
      );
      await assignToVerifyingPharmacy(uploaded.id as string, pharmacy.organizationId);

      const res = await request(ctx.server)
        .post(`/pharmacy/verification/${uploaded.id as string}/reject`)
        .set(...auth(wrongPharmacist.accessToken))
        .send({ reason: 'Not my pharmacy' });
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('VERIFICATION_FORBIDDEN');
    });

    it('self-review is rejected with 403 VERIFICATION_FORBIDDEN even if the uploader also holds PHARMACIST there', async () => {
      const pharmacy = await createActivatedPharmacy(ctx);
      const registered = await registerAndVerify(ctx);
      // Grant PHARMACIST to the same user at the verifying pharmacy's org *before* logging in —
      // the access token snapshots the effective permission set at issuance (JwtAuthGuard), so
      // the grant must land before login for this request's token to carry `prescription:verify`.
      const role = await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'PHARMACIST' } });
      await ctx.prisma.userRole.create({
        data: { userId: registered.userId, roleId: role.id, organizationId: pharmacy.organizationId },
      });
      const tokens = await login(ctx, registered.phone, registered.password);
      const customer = { ...registered, ...tokens };

      const uploaded = body(
        await request(ctx.server)
          .post('/prescriptions')
          .set(...auth(customer.accessToken))
          .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' })
          .expect(201),
      );
      await assignToVerifyingPharmacy(uploaded.id as string, pharmacy.organizationId);

      const res = await request(ctx.server)
        .post(`/pharmacy/verification/${uploaded.id as string}/reject`)
        .set(...auth(customer.accessToken))
        .send({ reason: 'Self review attempt' });
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('VERIFICATION_FORBIDDEN');
    });

    it('rejecting without a reason is rejected with 400 VALIDATION_ERROR', async () => {
      const customer = await customerTokens();
      const pharmacy = await createActivatedPharmacy(ctx);
      const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);

      const uploaded = body(
        await request(ctx.server)
          .post('/prescriptions')
          .set(...auth(customer.accessToken))
          .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' })
          .expect(201),
      );
      await assignToVerifyingPharmacy(uploaded.id as string, pharmacy.organizationId);

      const res = await request(ctx.server)
        .post(`/pharmacy/verification/${uploaded.id as string}/reject`)
        .set(...auth(pharmacist.accessToken))
        .send({});
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    });

    it('an invalid prescription state transition (double-approve) maps to 409 INVALID_PRESCRIPTION_STATE_TRANSITION', async () => {
      const customer = await customerTokens();
      const pharmacy = await createActivatedPharmacy(ctx);
      const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);
      const productId = await activeCatalogProduct();

      const uploaded = body(
        await request(ctx.server)
          .post('/prescriptions')
          .set(...auth(customer.accessToken))
          .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' })
          .expect(201),
      );
      await assignToVerifyingPharmacy(uploaded.id as string, pharmacy.organizationId);

      const approveBody = {
        lines: [{ catalogProductId: productId, approvedQuantity: 10, refillsAllowed: 0, isSingleUse: false }],
        legibilityOk: true,
        validityOk: true,
      };
      await request(ctx.server)
        .post(`/pharmacy/verification/${uploaded.id as string}/approve`)
        .set(...auth(pharmacist.accessToken))
        .send(approveBody)
        .expect(200);

      const res = await request(ctx.server)
        .post(`/pharmacy/verification/${uploaded.id as string}/approve`)
        .set(...auth(pharmacist.accessToken))
        .send(approveBody);
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('INVALID_PRESCRIPTION_STATE_TRANSITION');
    });

    it('clarify transitions to CLARIFICATION_REQUESTED, and the customer can then reupload', async () => {
      const customer = await customerTokens();
      const pharmacy = await createActivatedPharmacy(ctx);
      const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);

      const uploaded = body(
        await request(ctx.server)
          .post('/prescriptions')
          .set(...auth(customer.accessToken))
          .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' })
          .expect(201),
      );
      await assignToVerifyingPharmacy(uploaded.id as string, pharmacy.organizationId);

      const clarified = body(
        await request(ctx.server)
          .post(`/pharmacy/verification/${uploaded.id as string}/clarify`)
          .set(...auth(pharmacist.accessToken))
          .send({ message: 'Please re-upload a legible copy' })
          .expect(200),
      );
      expect(clarified.status).toBe('CLARIFICATION_REQUESTED');

      const reuploaded = body(
        await request(ctx.server)
          .post(`/prescriptions/${uploaded.id as string}/reupload`)
          .set(...auth(customer.accessToken))
          .send({ fileRef: 'file-ref-legible', fileType: 'application/pdf' })
          .expect(200),
      );
      expect(reuploaded.status).toBe('PENDING_VERIFICATION');
      expect(reuploaded.fileRef).toBe('file-ref-legible');
    });
  });

  describe('Matching endpoints (customer)', () => {
    it('find -> select happy path reserves real stock and returns the chosen pharmacy', async () => {
      const customer = await customerTokens();
      const productId = await activeCatalogProduct();
      const pharmacy = await createActivatedPharmacy(ctx);
      await createListing(pharmacy, productId, 10);

      const found = body(
        await request(ctx.server)
          .post('/matching/find')
          .set(...auth(customer.accessToken))
          .send({ lines: [{ catalogProductId: productId, quantity: 2 }] })
          .expect(201),
      ) as unknown as { matchRequest: { id: string }; candidates: unknown[] };
      expect(found.candidates.length).toBeGreaterThan(0);

      const getRes = body(
        await request(ctx.server)
          .get(`/matching/${found.matchRequest.id}`)
          .set(...auth(customer.accessToken))
          .expect(200),
      ) as unknown as { matchRequest: { status: string } };
      expect(getRes.matchRequest.status).toBe('PENDING');

      const selected = body(
        await request(ctx.server)
          .post(`/matching/${found.matchRequest.id}/select`)
          .set(...auth(customer.accessToken))
          .send({ lines: [{ catalogProductId: productId, quantity: 2 }] })
          .expect(200),
      ) as unknown as { status: string; chosenResult: { pharmacyId: string } };
      expect(selected.status).toBe('MATCHED');
      expect(selected.chosenResult.pharmacyId).toBe(pharmacy.pharmacyId);
    });

    it('rematch excludes the declined pharmacy and picks the next best', async () => {
      const customer = await customerTokens();
      const productId = await activeCatalogProduct();
      const declined = await createActivatedPharmacy(ctx);
      await createListing(declined, productId, 10);
      const backup = await createActivatedPharmacy(ctx);
      await createListing(backup, productId, 10);

      const found = body(
        await request(ctx.server)
          .post('/matching/find')
          .set(...auth(customer.accessToken))
          .send({ lines: [{ catalogProductId: productId, quantity: 2 }] })
          .expect(201),
      ) as unknown as { matchRequest: { id: string } };

      await request(ctx.server)
        .post(`/matching/${found.matchRequest.id}/select`)
        .set(...auth(customer.accessToken))
        .send({ pharmacyId: declined.pharmacyId, lines: [{ catalogProductId: productId, quantity: 2 }] })
        .expect(200);

      const rematched = body(
        await request(ctx.server)
          .post(`/matching/${found.matchRequest.id}/rematch`)
          .set(...auth(customer.accessToken))
          .send({ lines: [{ catalogProductId: productId, quantity: 2 }] })
          .expect(200),
      ) as unknown as { status: string; chosenResult: { pharmacyId: string } };
      expect(rematched.status).toBe('MATCHED');
      expect(rematched.chosenResult.pharmacyId).toBe(backup.pharmacyId);
    });

    it('returns 409 NO_PHARMACY_MATCH when no pharmacy covers the requested line', async () => {
      const customer = await customerTokens();
      const productId = await activeCatalogProduct();
      const res = await request(ctx.server)
        .post('/matching/find')
        .set(...auth(customer.accessToken))
        .send({ lines: [{ catalogProductId: productId, quantity: 2 }] });
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('NO_PHARMACY_MATCH');
    });

    it('rejects an invalid FindMatchDto (empty lines array) with 400 VALIDATION_ERROR', async () => {
      const customer = await customerTokens();
      const res = await request(ctx.server)
        .post('/matching/find')
        .set(...auth(customer.accessToken))
        .send({ lines: [] });
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    });

    it('a customer cannot read another customer\'s match result — 404, not a data leak', async () => {
      const owner = await customerTokens();
      const productId = await activeCatalogProduct();
      const pharmacy = await createActivatedPharmacy(ctx);
      await createListing(pharmacy, productId, 10);

      const found = body(
        await request(ctx.server)
          .post('/matching/find')
          .set(...auth(owner.accessToken))
          .send({ lines: [{ catalogProductId: productId, quantity: 2 }] })
          .expect(201),
      ) as unknown as { matchRequest: { id: string } };

      const stranger = await customerTokens();
      const res = await request(ctx.server)
        .get(`/matching/${found.matchRequest.id}`)
        .set(...auth(stranger.accessToken));
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PRESCRIPTION_NOT_FOUND');
    });

    it('a customer without matching:create:own cannot call /matching/find', async () => {
      // Registration always auto-grants CUSTOMER (which already carries matching:create:own) —
      // so exercising a real "missing permission" case requires stripping the auto-granted
      // CUSTOMER role (leaving only PHARMACY_OWNER, which has no matching:* permission) *before*
      // logging in, since the access token snapshots the effective permission set at issuance
      // (JwtAuthGuard).
      const registered = await registerAndVerify(ctx);
      const customerRole = await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'CUSTOMER' } });
      await ctx.prisma.userRole.deleteMany({
        where: { userId: registered.userId, roleId: customerRole.id },
      });
      const ownerRole = await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'PHARMACY_OWNER' } });
      await ctx.prisma.userRole.create({
        data: { userId: registered.userId, roleId: ownerRole.id, organizationId: null },
      });
      const tokens = await login(ctx, registered.phone, registered.password);

      const res = await request(ctx.server)
        .post('/matching/find')
        .set(...auth(tokens.accessToken))
        .send({ lines: [{ catalogProductId: '00000000-0000-0000-0000-000000000000', quantity: 1 }] });
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    });
  });
});
