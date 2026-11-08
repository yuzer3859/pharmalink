import request from 'supertest';
import { AssignVerifyingPharmacyCommand } from '../../src/modules/prescription-matching/application/commands/assign-verifying-pharmacy.command';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, errorOf, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, grantOrgRole } from '../pharmacy-inventory/support';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink test prescription\n%%EOF\n');
const pathOf = (url: string) => new URL(url).pathname;

/**
 * Work 101 (Phase 1 audit G7): a prescription's file is uploaded to document storage through a
 * signed link, checked before the prescription is recorded, and opened by the owner or the
 * reviewing pharmacist through a 5-minute link that is access-logged and audited.
 */
describe('Prescription files in document storage (Work 101, e2e)', () => {
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

  async function customer() {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);
    return { ...user, ...tokens };
  }

  async function uploadFile(token: string, content = PDF, contentType = 'application/pdf'): Promise<string> {
    const issued = body(
      await request(ctx.server).post('/prescriptions/uploads').set(...auth(token)).send({ contentType, bytes: content.length }).expect(201),
    ) as { fileRef: string; upload: { url: string; method: string } };
    expect(issued.fileRef).toMatch(/^doc:prescription\//);
    expect(issued.upload.method).toBe('PUT');
    await request(ctx.server).put(pathOf(issued.upload.url)).set('Content-Type', contentType).send(content).expect(200);
    return issued.fileRef;
  }

  const record = (token: string, fileRef: string, fileType = 'application/pdf') =>
    request(ctx.server).post('/prescriptions').set(...auth(token)).send({ fileRef, fileType });

  it('uploads through a signed link, records the prescription, and the owner can open the file', async () => {
    const owner = await customer();
    const fileRef = await uploadFile(owner.accessToken);
    const prescription = body(await record(owner.accessToken, fileRef).expect(201));
    expect(prescription.fileRef).toBe(fileRef);

    const link = body(await request(ctx.server).post(`/prescriptions/${prescription.id as string}/file`).set(...auth(owner.accessToken)).expect(200));
    expect(link).toMatchObject({ contentType: 'application/pdf', url: expect.any(String), expiresAt: expect.any(String) });
    const file = await request(ctx.server).get(pathOf(link.url as string)).expect(200);
    expect(file.headers['content-type']).toContain('application/pdf');

    expect(await ctx.prisma.auditLog.count({ where: { action: 'PRESCRIPTION_FILE_PREVIEWED', resourceId: prescription.id as string } })).toBe(1);
    expect(await ctx.prisma.prescriptionAccessLog.count({ where: { prescriptionId: prescription.id as string, accessType: 'DOWNLOAD' } })).toBe(1);
  });

  it("refuses someone else's file, a file not uploaded yet, and a declared type that does not match", async () => {
    const owner = await customer();
    const other = await customer();
    const fileRef = await uploadFile(owner.accessToken);

    expect(errorOf(await record(other.accessToken, fileRef).expect(400)).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(errorOf(await record(owner.accessToken, fileRef, 'image/png').expect(400)).code).toBe(ErrorCode.VALIDATION_ERROR);

    const notYet = body(
      await request(ctx.server).post('/prescriptions/uploads').set(...auth(owner.accessToken)).send({ contentType: 'application/pdf', bytes: 10 }).expect(201),
    ).fileRef as string;
    expect(errorOf(await record(owner.accessToken, notYet).expect(409)).code).toBe(ErrorCode.DOCUMENT_NOT_STORED);
    expect(await ctx.prisma.prescription.count()).toBe(0);
  });

  it.each([
    ['a type that is not a prescription file', { contentType: 'text/html', bytes: 10 }],
    ['an empty file', { contentType: 'application/pdf', bytes: 0 }],
    ['more than 10 MiB', { contentType: 'image/jpeg', bytes: 10 * 1024 * 1024 + 1 }],
  ])('refuses an upload link for %s', async (_label, payload) => {
    const owner = await customer();
    await request(ctx.server).post('/prescriptions/uploads').set(...auth(owner.accessToken)).send(payload).expect(400);
  });

  it('the reviewing pharmacist can open the file; another pharmacy cannot', async () => {
    const owner = await customer();
    const fileRef = await uploadFile(owner.accessToken);
    const prescription = body(await record(owner.accessToken, fileRef).expect(201));
    const pharmacy = await createActivatedPharmacy(ctx);
    const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);
    await ctx.app.get(AssignVerifyingPharmacyCommand).execute({ prescriptionId: prescription.id as string, pharmacyId: pharmacy.organizationId });

    await request(ctx.server).post(`/pharmacy/verification/${prescription.id as string}/file`).set(...auth(pharmacist.accessToken)).expect(200);

    const elsewhere = await createActivatedPharmacy(ctx);
    const outsider = await grantOrgRole(ctx, 'PHARMACIST', elsewhere.organizationId);
    const refused = await request(ctx.server).post(`/pharmacy/verification/${prescription.id as string}/file`).set(...auth(outsider.accessToken));
    expect([403, 404]).toContain(refused.status);
  });

  it('a prescription recorded before Work 101 (not a doc: reference) is still accepted, but has no file to open', async () => {
    const owner = await customer();
    const legacy = body(await record(owner.accessToken, 'legacy-file-ref').expect(201));
    const res = await request(ctx.server).post(`/prescriptions/${legacy.id as string}/file`).set(...auth(owner.accessToken)).expect(409);
    expect(errorOf(res).code).toBe(ErrorCode.DOCUMENT_NOT_STORED);
  });

  it('needs a signed-in customer', async () => {
    await request(ctx.server).post('/prescriptions/uploads').send({ contentType: 'application/pdf', bytes: 10 }).expect(401);
  });
});
