import request from 'supertest';
import { DOCUMENT_STORAGE_PORT, IDocumentStoragePort } from '../../src/shared/storage/document-storage.port';
import { InMemoryDocumentStorage } from '../../src/shared/storage/in-memory-document-storage';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink test licence\n%%EOF\n');

interface UploadBody {
  storageRef: string;
  upload: { url: string; method: string; headers: Record<string, string>; expiresAt: string };
}

/** The path of a signed local link: supertest drives the in-memory server, not a host. */
const pathOf = (url: string) => new URL(url).pathname;

/**
 * Work 89 against real PostgreSQL and the real HTTP stack, with `DOCUMENT_STORAGE=memory`: a
 * signed upload link, the upload straight to storage, the submission checked against what
 * landed, and the reviewer's audited, short-lived preview (backend/docs/document-storage.md).
 */
describe('Verification document upload and preview (e2e)', () => {
  let ctx: TestContext;
  let applicant: Awaited<ReturnType<typeof createUserWithRole>>;
  let admin: Awaited<ReturnType<typeof createUserWithRole>>;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    applicant = await createUserWithRole(ctx, 'CUSTOMER');
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  const requestUpload = (token: string, payload: Record<string, unknown>) =>
    request(ctx.server).post('/verification/documents/uploads').set(...auth(token)).send(payload);

  async function uploadPdf(token = applicant.accessToken, content = PDF): Promise<string> {
    const issued = body(await requestUpload(token, { contentType: 'application/pdf', bytes: content.length }).expect(201)) as unknown as UploadBody;
    expect(issued.upload.method).toBe('PUT');
    await request(ctx.server).put(pathOf(issued.upload.url)).set('Content-Type', 'application/pdf').send(content).expect(200);
    return issued.storageRef;
  }

  const submit = (token: string, storageRef: string) =>
    request(ctx.server)
      .post('/verification/documents')
      .set(...auth(token))
      .send({ type: 'DRIVER_DOCS', documents: [{ kind: 'DRIVING_LICENSE', storageRef }] });

  const preview = (token: string, requestId: string, index = 0) =>
    request(ctx.server).post(`/admin/verifications/${requestId}/documents/${index}/preview`).set(...auth(token)).send({});

  it('uploads straight to storage, submits the reference, and lets a reviewer preview it once audited', async () => {
    const storageRef = await uploadPdf();
    expect(storageRef).toMatch(new RegExp(`^doc:verification/${applicant.userId}/[0-9a-f-]{36}$`));
    const requestId = body(await submit(applicant.accessToken, storageRef).expect(202)).requestId as string;

    const detail = body(await request(ctx.server).get(`/admin/verifications/${requestId}`).set(...auth(admin.accessToken)).expect(200)) as {
      documents: Array<{ previewable: boolean }>;
    };
    expect(detail.documents[0].previewable).toBe(true);

    const link = body(await preview(admin.accessToken, requestId).expect(200)) as { url: string; contentType: string; expiresAt: string; kind: string };
    expect(link).toMatchObject({ kind: 'DRIVING_LICENSE', contentType: 'application/pdf' });
    const ttl = new Date(link.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);

    const file = await request(ctx.server).get(pathOf(link.url)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['content-disposition']).toBe('inline');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    const audits = await ctx.prisma.auditLog.findMany({ where: { action: { in: ['identity.verification.document_upload_issued', 'VERIFICATION_DOCUMENT_PREVIEWED'] } }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => [a.action, a.actorUserId])).toEqual([
      ['identity.verification.document_upload_issued', applicant.userId],
      ['VERIFICATION_DOCUMENT_PREVIEWED', admin.userId],
    ]);
    expect(audits[1]).toMatchObject({ resourceType: 'verification_request', resourceId: requestId });
    // A credential is never written to the trail.
    expect(JSON.stringify(audits.map((a) => a.context))).not.toContain('/storage/local/');
  });

  it.each([
    ['a type that is not a document', { contentType: 'text/html', bytes: 10 }],
    ['an empty file', { contentType: 'application/pdf', bytes: 0 }],
    ['more than 10 MiB', { contentType: 'application/pdf', bytes: 10 * 1024 * 1024 + 1 }],
    ['a fractional size', { contentType: 'image/png', bytes: 1.5 }],
    ['an unknown field', { contentType: 'image/png', bytes: 10, ownerId: 'x' }],
  ])('refuses an upload link for %s', async (_label, payload) => {
    const res = await requestUpload(applicant.accessToken, payload).expect(400);
    expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('holds the upload to the type and length the link was issued for, and to the link itself', async () => {
    const issued = body(await requestUpload(applicant.accessToken, { contentType: 'application/pdf', bytes: PDF.length }).expect(201)) as unknown as UploadBody;
    const path = pathOf(issued.upload.url);
    await request(ctx.server).put(path).set('Content-Type', 'image/png').send(PDF).expect(400);
    await request(ctx.server).put(path).set('Content-Type', 'application/pdf').send(Buffer.concat([PDF, PDF])).expect(400);
    await request(ctx.server).put(path).set('Content-Type', 'application/pdf').send(PDF.subarray(1)).expect(400);
    const tampered = path.slice(0, -2) + (path.endsWith('AA') ? 'BB' : 'AA');
    await request(ctx.server).put(tampered).set('Content-Type', 'application/pdf').send(PDF).expect(403);
    // An upload link is not a read link.
    await request(ctx.server).get(path).expect(403);
    // Nothing landed, so the reference cannot be submitted.
    expect(errorOf(await submit(applicant.accessToken, issued.storageRef).expect(400)).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('refuses to attach someone else’s upload, or a doc: reference that is not well formed', async () => {
    const other = await createUserWithRole(ctx, 'CUSTOMER');
    const theirs = await uploadPdf(other.accessToken);
    expect(errorOf(await submit(applicant.accessToken, theirs).expect(400)).code).toBe(ErrorCode.VALIDATION_ERROR);
    await submit(applicant.accessToken, 'doc:verification/../../etc/passwd').expect(400);
    await submit(applicant.accessToken, theirs.replace(other.userId, applicant.userId)).expect(400);
  });

  it('answers DOCUMENT_NOT_STORED for a reference-only document, 404 past the last one', async () => {
    const requestId = body(await submit(applicant.accessToken, 'enc://verification/legacy-1').expect(202)).requestId as string;
    expect(errorOf(await preview(admin.accessToken, requestId).expect(409)).code).toBe(ErrorCode.DOCUMENT_NOT_STORED);
    await preview(admin.accessToken, requestId, 1).expect(404);
    await preview(admin.accessToken, '00000000-0000-4000-8000-000000000000').expect(404);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'VERIFICATION_DOCUMENT_PREVIEWED' } })).toBe(0);
  });

  it('answers DOCUMENT_NOT_STORED when the file is missing from storage', async () => {
    const storageRef = await uploadPdf();
    const requestId = body(await submit(applicant.accessToken, storageRef).expect(202)).requestId as string;
    const storage = ctx.app.get<IDocumentStoragePort>(DOCUMENT_STORAGE_PORT) as InMemoryDocumentStorage;
    (storage as unknown as { objects: Map<string, unknown> }).objects.clear();
    expect(errorOf(await preview(admin.accessToken, requestId).expect(409)).code).toBe(ErrorCode.DOCUMENT_NOT_STORED);
  });

  it('keeps previews to reviewers, and upload links to signed-in users', async () => {
    const requestId = body(await submit(applicant.accessToken, await uploadPdf()).expect(202)).requestId as string;
    for (const role of ['CUSTOMER', 'FINANCE_OFFICER', 'CUSTOMER_SUPPORT'] as const) {
      const caller = await createUserWithRole(ctx, role);
      await preview(caller.accessToken, requestId).expect(403);
    }
    await preview(applicant.accessToken, requestId).expect(403);
    await request(ctx.server).post(`/admin/verifications/${requestId}/documents/0/preview`).expect(401);
    await request(ctx.server).post('/verification/documents/uploads').send({ contentType: 'application/pdf', bytes: 10 }).expect(401);
    await request(ctx.server).get('/storage/local/not-a-token').expect(403);
  });
});
