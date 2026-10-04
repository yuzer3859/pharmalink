import request from 'supertest';
import { AssignVerifyingPharmacyCommand } from '../../src/modules/prescription-matching/application/commands/assign-verifying-pharmacy.command';
import {
  DISPENSING_PORT,
  IDispensingPort,
} from '../../src/modules/prescription-matching/application/ports/inbound/dispensing.port';
import { auth, body, createUserWithRole, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, grantOrgRole } from '../pharmacy-inventory/support';

/**
 * Event-contract tests (module-05 §9 "Contract-testing note" / §18.3 `event-contracts.e2e-spec.ts`):
 * for every domain event this module emits, trigger the real command through the app (real HTTP
 * where a controller exists, real DI-resolved internal port otherwise, §10.4), read back the
 * resulting `outbox` row, and assert its envelope + payload conform to §9's payload/trigger table
 * and `architecture/00-domain-event-catalog.md`'s Module 05 row — mirroring
 * `test/pharmacy-inventory/event-contracts.e2e-spec.ts`'s exact pattern (envelope shape via
 * `OutboxService.write`: `{ id, type, aggregateType, aggregateId, payload, occurredAt }`).
 */
describe('Prescription & Matching domain events — contract vs. 00-domain-event-catalog.md / module-05 §9 (e2e)', () => {
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

  /** Reads back the single outbox row for `eventType`, parsed as the full `DomainEvent` envelope. */
  async function envelopeFor(eventType: string, aggregateId?: string) {
    const rows = await ctx.prisma.outbox.findMany({
      where: { eventType, ...(aggregateId ? { aggregateId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[rows.length - 1];
    const envelope = row.payload as {
      id: string;
      type: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      occurredAt: string;
    };
    expect(envelope.id).toEqual(expect.any(String));
    expect(envelope.type).toBe(eventType);
    expect(envelope.aggregateType).toEqual(expect.any(String));
    expect(envelope.aggregateId).toEqual(expect.any(String));
    expect(() => new Date(envelope.occurredAt).toISOString()).not.toThrow();
    expect(new Date(envelope.occurredAt).toISOString()).toBe(envelope.occurredAt);
    expect(row.aggregateType).toBe(envelope.aggregateType);
    expect(row.aggregateId).toBe(envelope.aggregateId);
    return envelope;
  }

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

  it('PrescriptionUploaded: prescription.uploaded carries { prescriptionId, customerUserId } (spec §9)', async () => {
    const customer = await customerTokens();
    const uploaded = body(
      await request(ctx.server)
        .post('/prescriptions')
        .set(...auth(customer.accessToken))
        .send({ fileRef: 'file-ref-1', fileType: 'application/pdf' })
        .expect(201),
    );

    const envelope = await envelopeFor('prescription.uploaded', uploaded.id as string);
    expect(envelope.aggregateType).toBe('Prescription');
    expect(envelope.payload).toMatchObject({
      prescriptionId: uploaded.id,
      customerUserId: customer.userId,
    });
  });

  it('PrescriptionApproved: prescription.approved carries { prescriptionId, lines: [{ lineId, catalogProductId, approvedQuantity }] } (spec §9)', async () => {
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

    await request(ctx.server)
      .post(`/pharmacy/verification/${uploaded.id as string}/approve`)
      .set(...auth(pharmacist.accessToken))
      .send({
        lines: [{ catalogProductId: productId, approvedQuantity: 10, refillsAllowed: 0, isSingleUse: false }],
        legibilityOk: true,
        validityOk: true,
      })
      .expect(200);

    const line = await ctx.prisma.prescriptionLine.findFirstOrThrow({
      where: { prescriptionId: uploaded.id as string },
    });

    const envelope = await envelopeFor('prescription.approved', uploaded.id as string);
    expect(envelope.aggregateType).toBe('Prescription');
    expect(envelope.payload).toMatchObject({
      prescriptionId: uploaded.id,
      lines: [{ lineId: line.id, catalogProductId: productId, approvedQuantity: 10 }],
    });
  });

  it('PrescriptionRejected: prescription.rejected carries { prescriptionId, reason } (spec §9)', async () => {
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

    await request(ctx.server)
      .post(`/pharmacy/verification/${uploaded.id as string}/reject`)
      .set(...auth(pharmacist.accessToken))
      .send({ reason: 'Illegible handwriting' })
      .expect(200);

    const envelope = await envelopeFor('prescription.rejected', uploaded.id as string);
    expect(envelope.aggregateType).toBe('Prescription');
    expect(envelope.payload).toMatchObject({
      prescriptionId: uploaded.id,
      reason: 'Illegible handwriting',
    });
  });

  it('MedicineDispensed: prescription.medicine_dispensed carries { prescriptionLineId, orderId, quantity } (spec §9)', async () => {
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
    await request(ctx.server)
      .post(`/pharmacy/verification/${uploaded.id as string}/approve`)
      .set(...auth(pharmacist.accessToken))
      .send({
        lines: [{ catalogProductId: productId, approvedQuantity: 10, refillsAllowed: 0, isSingleUse: false }],
        legibilityOk: true,
        validityOk: true,
      })
      .expect(200);

    const line = await ctx.prisma.prescriptionLine.findFirstOrThrow({
      where: { prescriptionId: uploaded.id as string },
    });

    const dispensing = ctx.app.get<IDispensingPort>(DISPENSING_PORT);
    const orderId = 'order-' + Math.random().toString(36).slice(2);
    await dispensing.dispense({
      prescriptionLineId: line.id,
      idempotencyKey: 'idem-1',
      orderId,
      pharmacyId: pharmacy.pharmacyId,
      quantity: 4,
      dispensedByUserId: pharmacist.userId,
    });

    const envelope = await envelopeFor('prescription.medicine_dispensed', line.id);
    expect(envelope.aggregateType).toBe('PrescriptionLine');
    expect(envelope.payload).toMatchObject({
      prescriptionLineId: line.id,
      orderId,
      quantity: 4,
    });
  });

  it('OrderMatched: matching.order_matched carries { matchRequestId, orderId: null, result } on select (spec §9)', async () => {
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
    ) as unknown as { matchRequest: { id: string } };

    const selected = body(
      await request(ctx.server)
        .post(`/matching/${found.matchRequest.id}/select`)
        .set(...auth(customer.accessToken))
        .send({ lines: [{ catalogProductId: productId, quantity: 2 }] })
        .expect(200),
    ) as unknown as { chosenResult: { pharmacyId: string } };

    const envelope = await envelopeFor('matching.order_matched', found.matchRequest.id);
    expect(envelope.aggregateType).toBe('MatchRequest');
    expect(envelope.payload.matchRequestId).toBe(found.matchRequest.id);
    // `orderId` remains null/absent until Module 06 exists and actually creates an order (§9 note).
    expect(envelope.payload.orderId ?? null).toBeNull();
    expect(envelope.payload.result).toMatchObject({ pharmacyId: selected.chosenResult.pharmacyId });
  });

  it('RematchTriggered: matching.rematch_triggered carries { matchRequestId, excludedPharmacyId } when a new candidate is found (spec §9)', async () => {
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

    await request(ctx.server)
      .post(`/matching/${found.matchRequest.id}/rematch`)
      .set(...auth(customer.accessToken))
      .send({ lines: [{ catalogProductId: productId, quantity: 2 }] })
      .expect(200);

    const envelope = await envelopeFor('matching.rematch_triggered', found.matchRequest.id);
    expect(envelope.aggregateType).toBe('MatchRequest');
    expect(envelope.payload).toMatchObject({
      matchRequestId: found.matchRequest.id,
      excludedPharmacyId: declined.pharmacyId,
    });
  });

  it('MatchFailed: matching.match_failed carries { matchRequestId } once every candidate is exhausted (spec §9)', async () => {
    const customer = await customerTokens();
    const productId = await activeCatalogProduct();
    const onlyPharmacy = await createActivatedPharmacy(ctx);
    await createListing(onlyPharmacy, productId, 10);

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
      .send({ pharmacyId: onlyPharmacy.pharmacyId, lines: [{ catalogProductId: productId, quantity: 2 }] })
      .expect(200);

    const rematched = body(
      await request(ctx.server)
        .post(`/matching/${found.matchRequest.id}/rematch`)
        .set(...auth(customer.accessToken))
        .send({ lines: [{ catalogProductId: productId, quantity: 2 }] }),
    ) as unknown as { status?: string };
    expect(rematched.status).toBe('FAILED');

    const envelope = await envelopeFor('matching.match_failed', found.matchRequest.id);
    expect(envelope.aggregateType).toBe('MatchRequest');
    expect(envelope.payload).toMatchObject({ matchRequestId: found.matchRequest.id });
  });
});
