import request from 'supertest';
import { ApprovePrescriptionCommand } from '../../src/modules/prescription-matching/application/commands/approve-prescription.command';
import { AssignVerifyingPharmacyCommand } from '../../src/modules/prescription-matching/application/commands/assign-verifying-pharmacy.command';
import { FindMatchCommand } from '../../src/modules/prescription-matching/application/commands/find-match.command';
import { RejectPrescriptionCommand } from '../../src/modules/prescription-matching/application/commands/reject-prescription.command';
import { RematchCommand } from '../../src/modules/prescription-matching/application/commands/rematch.command';
import { SelectMatchCommand } from '../../src/modules/prescription-matching/application/commands/select-match.command';
import { UploadPrescriptionCommand } from '../../src/modules/prescription-matching/application/commands/upload-prescription.command';
import { CATALOG_PORT, ICatalogPort } from '../../src/modules/prescription-matching/application/ports/outbound/catalog.port';
import { IDENTITY_PORT, IIdentityPort } from '../../src/modules/prescription-matching/application/ports/outbound/identity.port';
import { AVAILABILITY_PORT, IAvailabilityPort } from '../../src/modules/prescription-matching/application/ports/outbound/availability.port';
import { IMatchingPort, MATCHING_PORT } from '../../src/modules/prescription-matching/application/ports/inbound/matching.port';
import { MatchingPortAdapter } from '../../src/modules/prescription-matching/application/ports/inbound/matching-port.adapter';
import { UNIT_OF_WORK } from '../../src/modules/prescription-matching/application/ports/unit-of-work.port';
import { CatalogPortAdapter } from '../../src/modules/prescription-matching/infrastructure/catalog/catalog-port.adapter';
import { IdentityPortAdapter } from '../../src/modules/prescription-matching/infrastructure/identity/identity-port.adapter';
import { AvailabilityPortAdapter } from '../../src/modules/prescription-matching/infrastructure/availability/availability-port.adapter';
import { PrismaUnitOfWork } from '../../src/modules/prescription-matching/infrastructure/persistence/prisma-unit-of-work';
import { AuditService } from '../../src/shared/audit/audit.service';
import { auth, body, createUserWithRole, grantRoleDirect, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, createPharmacyOrganization, grantOrgRole } from '../pharmacy-inventory/support';

/**
 * Confirms the real (unmocked) `ICatalogPort`/`IIdentityPort`/`IAvailabilityPort` adapters and
 * Module 04's exported `IInventoryPort` all work end-to-end against genuine seeded Module
 * 01/03/04 data — not the in-memory test doubles `test/prescription-matching/fakes.ts` uses for
 * pure application-layer command tests (module-05 Task 7 §10). Mirrors
 * `test/pharmacy-inventory/dedup-catalog-integration.e2e-spec.ts`'s "real cross-module port
 * integration" pattern: boots the real `AppModule` (which now includes
 * `PrescriptionMatchingModule`) and resolves the real command instances via Nest DI —
 * `PrescriptionMatchingModule` has no controllers yet (interface/HTTP is a later task), so
 * commands are invoked directly, exactly like Module 04's own inbound ports are consumed
 * in-process.
 */
describe('Prescription & Matching — real cross-module infrastructure adapters (e2e)', () => {
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

  async function activeCatalogProduct(rxClassification: 'RX' | 'OTC' = 'RX'): Promise<string> {
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
          genericName: 'Amoxicillin',
          manufacturerId: mfr.id,
          dosageForm: 'TABLET',
          strengthValue: 500,
          strengthUnit: 'MG',
          rxClassification,
          nameEn: 'Amoxicillin 500mg',
        })
        .expect(201),
    );
    // Published only through catalogue review (module-16 Work 30): submit (DRAFT -> PENDING_REVIEW), then approve (-> ACTIVE).
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(admin.accessToken)).expect(200);
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(admin.accessToken)).expect(200);
    return product.id as string;
  }

  async function draftCatalogProduct(): Promise<string> {
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
          genericName: 'Draft Med',
          manufacturerId: mfr.id,
          dosageForm: 'TABLET',
          strengthValue: 250,
          strengthUnit: 'MG',
          rxClassification: 'OTC',
          nameEn: 'Draft Med 250mg',
        })
        .expect(201),
    );
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
          price: 500,
          batchNumber: 'B-1',
          initialQuantity: quantity,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    return { branchId: branch.branchId as string, listingId: listing.listingId as string };
  }

  describe('ICatalogPort — real Module 03 Product reads', () => {
    it('ApprovePrescriptionCommand resolves a real, ACTIVE catalog product via the real adapter', async () => {
      const catalog = ctx.app.get<ICatalogPort>(CATALOG_PORT);
      expect(catalog).toBeInstanceOf(CatalogPortAdapter);
      const productId = await activeCatalogProduct();

      const view = await catalog.getProduct(productId);
      expect(view).toMatchObject({ id: productId, status: 'ACTIVE', rxClassification: 'RX' });

      const upload = ctx.app.get(UploadPrescriptionCommand);
      const assign = ctx.app.get(AssignVerifyingPharmacyCommand);
      const approve = ctx.app.get(ApprovePrescriptionCommand);

      const customer = await registerAndVerify(ctx);
      const pharmacy = await createActivatedPharmacy(ctx);
      const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);

      const prescription = await upload.execute({
        customerUserId: customer.userId,
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });
      await assign.execute({ prescriptionId: prescription.id, pharmacyId: pharmacy.organizationId });

      const approved = await approve.execute({
        prescriptionId: prescription.id,
        reviewerUserId: pharmacist.userId,
        lines: [{ catalogProductId: productId, approvedQuantity: 10, refillsAllowed: 0, isSingleUse: false }],
        legibilityOk: true,
        validityOk: true,
      });
      expect(approved.status).toBe('APPROVED');
    });

    it('rejects approval referencing a catalog product that does not exist (real adapter, 404)', async () => {
      const upload = ctx.app.get(UploadPrescriptionCommand);
      const assign = ctx.app.get(AssignVerifyingPharmacyCommand);
      const approve = ctx.app.get(ApprovePrescriptionCommand);

      const customer = await registerAndVerify(ctx);
      const pharmacy = await createActivatedPharmacy(ctx);
      const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);

      const prescription = await upload.execute({
        customerUserId: customer.userId,
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });
      await assign.execute({ prescriptionId: prescription.id, pharmacyId: pharmacy.organizationId });

      await expect(
        approve.execute({
          prescriptionId: prescription.id,
          reviewerUserId: pharmacist.userId,
          lines: [
            {
              catalogProductId: '00000000-0000-0000-0000-000000000000',
              approvedQuantity: 10,
              refillsAllowed: 0,
              isSingleUse: false,
            },
          ],
          legibilityOk: true,
          validityOk: true,
        }),
      ).rejects.toMatchObject({ code: 'CATALOG_PRODUCT_NOT_FOUND' });
    });

    it('rejects approval referencing a DRAFT (not-yet-ACTIVE) catalog product (real adapter)', async () => {
      const upload = ctx.app.get(UploadPrescriptionCommand);
      const assign = ctx.app.get(AssignVerifyingPharmacyCommand);
      const approve = ctx.app.get(ApprovePrescriptionCommand);

      const customer = await registerAndVerify(ctx);
      const pharmacy = await createActivatedPharmacy(ctx);
      const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);
      const draftProductId = await draftCatalogProduct();

      const prescription = await upload.execute({
        customerUserId: customer.userId,
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });
      await assign.execute({ prescriptionId: prescription.id, pharmacyId: pharmacy.organizationId });

      await expect(
        approve.execute({
          prescriptionId: prescription.id,
          reviewerUserId: pharmacist.userId,
          lines: [
            { catalogProductId: draftProductId, approvedQuantity: 10, refillsAllowed: 0, isSingleUse: false },
          ],
          legibilityOk: true,
          validityOk: true,
        }),
      ).rejects.toMatchObject({ code: 'CATALOG_PRODUCT_NOT_FOUND' });
    });
  });

  describe('IIdentityPort — real Module 01 user_roles/organizations reads (VerificationPolicy authorization)', () => {
    it('allows a reviewer holding PHARMACIST at the correct verifying-pharmacy organization', async () => {
      const identity = ctx.app.get<IIdentityPort>(IDENTITY_PORT);
      expect(identity).toBeInstanceOf(IdentityPortAdapter);
      const pharmacy = await createActivatedPharmacy(ctx);
      const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);

      expect(
        await identity.hasRoleAtOrganization(pharmacist.userId, pharmacy.organizationId, 'PHARMACIST'),
      ).toBe(true);
      expect(await identity.getUserOrganizationIds(pharmacist.userId)).toContain(pharmacy.organizationId);
    });

    it('rejects a reviewer holding PHARMACIST at the wrong organization (VERIFICATION_FORBIDDEN)', async () => {
      const upload = ctx.app.get(UploadPrescriptionCommand);
      const assign = ctx.app.get(AssignVerifyingPharmacyCommand);
      const approve = ctx.app.get(ApprovePrescriptionCommand);

      const customer = await registerAndVerify(ctx);
      const pharmacy = await createActivatedPharmacy(ctx);
      const otherOrgOwner = await registerAndVerify(ctx);
      const { organizationId: otherOrgId } = await createPharmacyOrganization(ctx, otherOrgOwner.userId);
      const wrongPharmacist = await grantOrgRole(ctx, 'PHARMACIST', otherOrgId);
      const productId = await activeCatalogProduct();

      const prescription = await upload.execute({
        customerUserId: customer.userId,
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });
      await assign.execute({ prescriptionId: prescription.id, pharmacyId: pharmacy.organizationId });

      await expect(
        approve.execute({
          prescriptionId: prescription.id,
          reviewerUserId: wrongPharmacist.userId,
          lines: [{ catalogProductId: productId, approvedQuantity: 10, refillsAllowed: 0, isSingleUse: false }],
          legibilityOk: true,
          validityOk: true,
        }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_FORBIDDEN' });
    });

    it('rejects self-review even when the uploading customer also holds PHARMACIST at the verifying pharmacy', async () => {
      const upload = ctx.app.get(UploadPrescriptionCommand);
      const assign = ctx.app.get(AssignVerifyingPharmacyCommand);
      const reject = ctx.app.get(RejectPrescriptionCommand);

      const pharmacy = await createActivatedPharmacy(ctx);
      const customer = await registerAndVerify(ctx);
      await grantRoleDirect(ctx, customer.userId, 'PHARMACIST', pharmacy.organizationId);

      const prescription = await upload.execute({
        customerUserId: customer.userId,
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });
      await assign.execute({ prescriptionId: prescription.id, pharmacyId: pharmacy.organizationId });

      await expect(
        reject.execute({
          prescriptionId: prescription.id,
          reviewerUserId: customer.userId,
          reason: 'Self-approving my own prescription',
        }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_FORBIDDEN' });
    });
  });

  describe('IAvailabilityPort — real Module 04 GetAvailabilityQuery reads (matching)', () => {
    it('ranks real listings across real pharmacies and excludes a disabled listing', async () => {
      const findMatch = ctx.app.get(FindMatchCommand);
      const productId = await activeCatalogProduct('OTC');

      const nearPharmacy = await createActivatedPharmacy(ctx);
      const { listingId: nearListingId } = await createListing(nearPharmacy, productId, 20);

      const farPharmacy = await createActivatedPharmacy(ctx);
      await createListing(farPharmacy, productId, 20);

      const disabledPharmacy = await createActivatedPharmacy(ctx);
      const { listingId: disabledListingId } = await createListing(disabledPharmacy, productId, 20);
      await request(ctx.server)
        .patch(`/inventory/listings/${disabledListingId}`)
        .set(...auth(disabledPharmacy.accessToken))
        .send({ isEnabled: false })
        .expect(200);

      const customer = await registerAndVerify(ctx);
      const result = await findMatch.execute({
        customerUserId: customer.userId,
        lines: [{ catalogProductId: productId, quantity: 2 }],
      });

      const pharmacyIds = result.candidates.map((c) => c.pharmacyId);
      expect(pharmacyIds).toContain(nearPharmacy.pharmacyId);
      expect(pharmacyIds).toContain(farPharmacy.pharmacyId);
      expect(pharmacyIds).not.toContain(disabledPharmacy.pharmacyId);

      // Sanity: the real adapter's shape carries what MatchRankingStrategy needs (price,
      // distance) and no rating field (§0.2 — Slice 1 ranks distance -> price only).
      const availability = ctx.app.get<IAvailabilityPort>(AVAILABILITY_PORT);
      expect(availability).toBeInstanceOf(AvailabilityPortAdapter);
      const rows = await availability.getAvailability(productId);
      expect(rows.some((r) => r.listingId === nearListingId)).toBe(true);
      for (const row of rows) {
        expect(row).not.toHaveProperty('rating');
      }
    });

    it('throws NO_PHARMACY_MATCH when the only listing lacks sufficient sellable stock', async () => {
      const findMatch = ctx.app.get(FindMatchCommand);
      const productId = await activeCatalogProduct('OTC');
      const pharmacy = await createActivatedPharmacy(ctx);
      await createListing(pharmacy, productId, 1);

      const customer = await registerAndVerify(ctx);
      await expect(
        findMatch.execute({
          customerUserId: customer.userId,
          lines: [{ catalogProductId: productId, quantity: 5 }],
        }),
      ).rejects.toMatchObject({ code: 'NO_PHARMACY_MATCH' });
    });
  });

  describe('Module 04 IInventoryPort — real reserve/release via SelectMatchCommand/RematchCommand (ADR-014)', () => {
    it('SelectMatchCommand reserves real stock and decrements real sellable availability', async () => {
      const findMatch = ctx.app.get(FindMatchCommand);
      const selectMatch = ctx.app.get(SelectMatchCommand);
      const productId = await activeCatalogProduct('OTC');
      const pharmacy = await createActivatedPharmacy(ctx);
      const { listingId } = await createListing(pharmacy, productId, 10);

      const customer = await registerAndVerify(ctx);
      const found = await findMatch.execute({
        customerUserId: customer.userId,
        lines: [{ catalogProductId: productId, quantity: 3 }],
      });

      const selected = await selectMatch.execute({
        matchRequestId: found.matchRequest.id,
        customerUserId: customer.userId,
        lines: [{ catalogProductId: productId, quantity: 3 }],
      });

      expect(selected.status).toBe('MATCHED');
      expect(selected.chosenResult?.pharmacyId).toBe(pharmacy.pharmacyId);

      const reservationId = selected.chosenResult?.lines[0]?.reservationId as string;
      const reservation = await ctx.prisma.stockReservation.findUniqueOrThrow({
        where: { id: reservationId },
      });
      expect(reservation.status).toBe('HELD');
      expect(reservation.listingId).toBe(listingId);
      expect(reservation.quantity).toBe(3);

      const availabilityAfter = body(
        await request(ctx.server).get(`/availability/product/${productId}`).expect(200),
      ) as unknown as Array<{ listingId: string; sellable: number }>;
      expect(availabilityAfter.find((r) => r.listingId === listingId)?.sellable).toBe(7);

      // Audit: MATCH_SELECTED persisted via the real, shared AuditService in the same
      // Serializable transaction as the MatchRequest status update (§12/§13, ADR-013).
      const auditRows = await ctx.prisma.auditLog.findMany({
        where: { resourceId: found.matchRequest.id, action: 'MATCH_SELECTED' },
      });
      expect(auditRows).toHaveLength(1);

      // Outbox: matching.order_matched persisted in the same transaction (§9/§13, reused OutboxService).
      const outboxRows = await ctx.prisma.outbox.findMany({
        where: { aggregateId: found.matchRequest.id, eventType: 'matching.order_matched' },
      });
      expect(outboxRows).toHaveLength(1);
    });

    it('RematchCommand releases the declined reservation first, then reserves at the next-ranked real pharmacy (ADR-014 ordering)', async () => {
      const findMatch = ctx.app.get(FindMatchCommand);
      const selectMatch = ctx.app.get(SelectMatchCommand);
      const rematch = ctx.app.get(RematchCommand);
      const productId = await activeCatalogProduct('OTC');

      const declinedPharmacy = await createActivatedPharmacy(ctx);
      await createListing(declinedPharmacy, productId, 10);
      const backupPharmacy = await createActivatedPharmacy(ctx);
      const { listingId: backupListingId } = await createListing(backupPharmacy, productId, 10);

      const customer = await registerAndVerify(ctx);
      const found = await findMatch.execute({
        customerUserId: customer.userId,
        lines: [{ catalogProductId: productId, quantity: 2 }],
      });

      const selected = await selectMatch.execute({
        matchRequestId: found.matchRequest.id,
        customerUserId: customer.userId,
        pharmacyId: declinedPharmacy.pharmacyId,
        lines: [{ catalogProductId: productId, quantity: 2 }],
      });
      const declinedReservationId = selected.chosenResult?.lines[0]?.reservationId as string;

      const rematched = await rematch.execute({
        matchRequestId: found.matchRequest.id,
        customerUserId: customer.userId,
        lines: [{ catalogProductId: productId, quantity: 2 }],
      });

      expect(rematched.status).toBe('MATCHED');
      expect(rematched.chosenResult?.pharmacyId).toBe(backupPharmacy.pharmacyId);

      // The declined pharmacy's original reservation is released (compensating action, called
      // *before* this module's own MatchRequest update per ADR-014's documented ordering).
      const declinedReservation = await ctx.prisma.stockReservation.findUniqueOrThrow({
        where: { id: declinedReservationId },
      });
      expect(declinedReservation.status).toBe('RELEASED');

      const newReservationId = rematched.chosenResult?.lines[0]?.reservationId as string;
      const newReservation = await ctx.prisma.stockReservation.findUniqueOrThrow({
        where: { id: newReservationId },
      });
      expect(newReservation.status).toBe('HELD');
      expect(newReservation.listingId).toBe(backupListingId);

      const auditRows = await ctx.prisma.auditLog.findMany({
        where: { resourceId: found.matchRequest.id, action: 'MATCH_REMATCHED' },
      });
      expect(auditRows).toHaveLength(1);
    });
  });

  describe('PrismaUnitOfWork — real Serializable transaction wired via DI', () => {
    it('resolves the real PrismaUnitOfWork (not a fake) for the module', () => {
      const uow = ctx.app.get(UNIT_OF_WORK);
      expect(uow).toBeInstanceOf(PrismaUnitOfWork);
    });

    it('commits Prescription state + AuditService entry + outbox event together via the real UnitOfWork', async () => {
      const upload = ctx.app.get(UploadPrescriptionCommand);
      const customer = await registerAndVerify(ctx);

      const prescription = await upload.execute({
        customerUserId: customer.userId,
        fileRef: 'file-ref-1',
        fileType: 'application/pdf',
      });

      const audit = ctx.app.get(AuditService);
      expect(audit).toBeInstanceOf(AuditService);

      const auditRows = await ctx.prisma.auditLog.findMany({
        where: { resourceId: prescription.id, action: 'PRESCRIPTION_UPLOADED' },
      });
      expect(auditRows).toHaveLength(1);

      const outboxRows = await ctx.prisma.outbox.findMany({
        where: { aggregateId: prescription.id, eventType: 'prescription.uploaded' },
      });
      expect(outboxRows).toHaveLength(1);
    });
  });

  describe('MATCHING_PORT — module-06 checkout boundary (06-orders-spec.md §13.1 Option B)', () => {
    it('resolves the real MatchingPortAdapter (not a fake) from PrescriptionMatchingModule', () => {
      const port = ctx.app.get<IMatchingPort>(MATCHING_PORT);
      expect(port).toBeInstanceOf(MatchingPortAdapter);
    });

    it('IMatchingPort.find()/select() delegate to the same real commands the HTTP controller uses, end to end', async () => {
      const port = ctx.app.get<IMatchingPort>(MATCHING_PORT);
      const customer = await registerAndVerify(ctx);
      const productId = await activeCatalogProduct('OTC');
      const pharmacy = await createActivatedPharmacy(ctx);
      await createListing(pharmacy, productId, 10);

      const found = await port.find({
        customerUserId: customer.userId,
        lines: [{ catalogProductId: productId, quantity: 2 }],
      });
      expect(found.candidates.length).toBeGreaterThan(0);

      const selected = await port.select({
        matchRequestId: found.matchRequest.id,
        customerUserId: customer.userId,
        lines: [{ catalogProductId: productId, quantity: 2 }],
      });
      expect(selected.status).toBe('MATCHED');
      expect(selected.chosenResult?.pharmacyId).toBe(pharmacy.pharmacyId);

      // Same row a direct FindMatchCommand/SelectMatchCommand caller (e.g. the HTTP controller)
      // would have produced — the port adds no parallel state, no duplicate write.
      const persisted = await ctx.prisma.matchRequest.findUniqueOrThrow({
        where: { id: found.matchRequest.id },
      });
      expect(persisted.status).toBe('MATCHED');
    });
  });
});
