import { randomUUID } from 'crypto';
import request from 'supertest';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type Account = Awaited<ReturnType<typeof createUserWithRole>>;

interface OwnReview {
  reviewId: string;
  status: string;
  rating: number;
  targetId: string;
  verifiedPurchase: boolean;
  edited: boolean;
}

/**
 * Work 91 against real PostgreSQL and the real HTTP stack: Module 15's verified-purchase reviews,
 * reports and automatic holding, the public listing and rating, and Module 16's moderation desk
 * and unified flagged-content view (backend/docs/reviews.md).
 */
describe('Reviews and moderation (e2e)', () => {
  let ctx: TestContext;
  let customer: Account;
  let admin: Account;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    customer = await createUserWithRole(ctx, 'CUSTOMER');
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  /** A Module 06 order in `status`, fulfilled by the given pharmacies (test-only state). */
  async function order(owner: Account, status: string, pharmacies: string[] = [randomUUID()]) {
    const id = randomUUID();
    await ctx.prisma.order.create({
      data: {
        id,
        orderNumber: `ORD-${id.slice(0, 8)}`,
        customerUserId: owner.userId,
        idempotencyKey: `idem-${id}`,
        status: status as never,
        completedAt: status === 'COMPLETED' ? new Date() : null,
        fulfillments: { create: pharmacies.map((pharmacyId) => ({ pharmacyId, branchId: randomUUID(), status: 'DELIVERED' as never })) },
      },
    });
    return { orderId: id, pharmacyId: pharmacies[0] };
  }

  const submit = (who: Account, payload: Record<string, unknown>) => request(ctx.server).post('/reviews').set(...auth(who.accessToken)).send(payload);
  const reportIt = (who: Account, id: string, reason = 'SPAM') => request(ctx.server).post(`/reviews/${id}/report`).set(...auth(who.accessToken)).send({ reason });
  const publicList = (pharmacyId: string) => request(ctx.server).get(`/subjects/PHARMACY/${pharmacyId}/reviews`).expect(200);
  const moderate = (who: Account, id: string, move: string, reason = 'Breaks the review policy') =>
    request(ctx.server).post(`/admin/reviews/${id}/${move}`).set(...auth(who.accessToken)).send({ reason });

  it('publishes a verified review of the pharmacy that fulfilled a delivered order and keeps the rating exact', async () => {
    const { orderId, pharmacyId } = await order(customer, 'DELIVERED');
    const own = body(await submit(customer, { orderId, rating: 4, title: 'Quick', body: 'Ready in an hour.' }).expect(201)) as unknown as OwnReview;
    expect(own).toMatchObject({ status: 'PUBLISHED', rating: 4, targetId: pharmacyId, verifiedPurchase: true, edited: false });

    const other = await createUserWithRole(ctx, 'CUSTOMER');
    const second = await order(other, 'COMPLETED', [pharmacyId]);
    await submit(other, { orderId: second.orderId, rating: 1 }).expect(201);

    const page = body(await publicList(pharmacyId)) as { items: Array<Record<string, unknown>>; total: number; rating: { ratingCount: number; ratingAvg: number; distribution: Record<string, number> } };
    expect(page.total).toBe(2);
    expect(page.rating).toMatchObject({ ratingCount: 2, ratingAvg: 2.5, distribution: { '1': 1, '2': 0, '3': 0, '4': 1, '5': 0 } });
    // Public: no author, no order.
    expect(JSON.stringify(page.items)).not.toContain(customer.userId);
    expect(JSON.stringify(page.items)).not.toContain(orderId);
    expect(body(await request(ctx.server).get(`/subjects/PHARMACY/${pharmacyId}/rating`).expect(200))).toMatchObject({ ratingCount: 2 });

    const audit = await ctx.prisma.auditLog.findMany({ where: { action: 'REVIEW_SUBMITTED' } });
    expect(audit).toHaveLength(2);
  });

  it('refuses an order that is not the caller’s, not yet received, or not fulfilled by that pharmacy (BRULE-45)', async () => {
    const stranger = await createUserWithRole(ctx, 'CUSTOMER');
    const theirs = await order(stranger, 'DELIVERED');
    expect(errorOf(await submit(customer, { orderId: theirs.orderId, rating: 5 }).expect(422)).code).toBe(ErrorCode.TRANSACTION_NOT_ELIGIBLE);
    for (const status of ['PAID', 'DISPATCHED', 'CANCELLED']) {
      const o = await order(customer, status);
      expect(errorOf(await submit(customer, { orderId: o.orderId, rating: 5 }).expect(422)).code).toBe(ErrorCode.TRANSACTION_NOT_ELIGIBLE);
    }
    const mine = await order(customer, 'DELIVERED');
    await submit(customer, { orderId: mine.orderId, pharmacyId: randomUUID(), rating: 5 }).expect(422);
    await submit(customer, { orderId: randomUUID(), rating: 5 }).expect(422);
  });

  it('allows one review per order and pharmacy (BRULE-47), and asks which pharmacy for a split order', async () => {
    const { orderId } = await order(customer, 'DELIVERED');
    await submit(customer, { orderId, rating: 5 }).expect(201);
    expect(errorOf(await submit(customer, { orderId, rating: 3 }).expect(409)).code).toBe(ErrorCode.ALREADY_REVIEWED);

    const [a, b] = [randomUUID(), randomUUID()];
    const split = await order(customer, 'DELIVERED', [a, b]);
    expect(errorOf(await submit(customer, { orderId: split.orderId, rating: 5 }).expect(400)).code).toBe(ErrorCode.VALIDATION_ERROR);
    await submit(customer, { orderId: split.orderId, pharmacyId: a, rating: 5 }).expect(201);
    await submit(customer, { orderId: split.orderId, pharmacyId: b, rating: 2 }).expect(201);
  });

  it.each([
    ['a rating of 0', { rating: 0 }],
    ['a rating of 6', { rating: 6 }],
    ['a fractional rating', { rating: 3.5 }],
    ['an over-long body', { rating: 3, body: 'x'.repeat(2001) }],
    ['an unknown field', { rating: 3, authorUserId: 'x' }],
  ])('refuses %s', async (_label, extra) => {
    const { orderId } = await order(customer, 'DELIVERED');
    expect(errorOf(await submit(customer, { orderId, ...extra }).expect(400)).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('holds a review with a link, an e-mail address or a phone number for a moderator, out of public view', async () => {
    for (const text of ['Order at www.cheap-pills.example', 'Write to me at a.b@example.com', 'Call 0911 234 567']) {
      const o = await order(customer, 'DELIVERED');
      const own = body(await submit(customer, { orderId: o.orderId, rating: 5, body: text }).expect(201)) as unknown as OwnReview;
      expect({ text, status: own.status }).toEqual({ text, status: 'FLAGGED' });
      expect((body(await publicList(o.pharmacyId)) as { total: number }).total).toBe(0);
    }
  });

  it('lets the author edit within the window, and the content rules run again', async () => {
    const { orderId } = await order(customer, 'DELIVERED');
    const own = body(await submit(customer, { orderId, rating: 2 }).expect(201)) as unknown as OwnReview;
    const edited = body(await request(ctx.server).patch(`/reviews/${own.reviewId}`).set(...auth(customer.accessToken)).send({ rating: 4, body: 'Better now' }).expect(200)) as unknown as OwnReview;
    expect(edited).toMatchObject({ rating: 4, edited: true, status: 'PUBLISHED' });
    const flagged = body(await request(ctx.server).patch(`/reviews/${own.reviewId}`).set(...auth(customer.accessToken)).send({ rating: 4, body: 'see https://x.example' }).expect(200)) as unknown as OwnReview;
    expect(flagged.status).toBe('FLAGGED');

    await ctx.prisma.review.update({ where: { id: own.reviewId }, data: { createdAt: new Date(Date.now() - 15 * 86_400_000) } });
    expect(errorOf(await request(ctx.server).patch(`/reviews/${own.reviewId}`).set(...auth(customer.accessToken)).send({ rating: 5 }).expect(409)).code).toBe(ErrorCode.EDIT_WINDOW_CLOSED);
    const stranger = await createUserWithRole(ctx, 'CUSTOMER');
    await request(ctx.server).patch(`/reviews/${own.reviewId}`).set(...auth(stranger.accessToken)).send({ rating: 5 }).expect(404);
    expect(((body(await request(ctx.server).get('/reviews/mine').set(...auth(customer.accessToken)).expect(200)) as unknown) as OwnReview[]).map((r) => r.reviewId)).toEqual([own.reviewId]);
  });

  it('holds a review after three distinct reports, counts a repeat once, and refuses reporting one’s own', async () => {
    const { orderId, pharmacyId } = await order(customer, 'DELIVERED');
    const own = body(await submit(customer, { orderId, rating: 5 }).expect(201)) as unknown as OwnReview;
    await reportIt(customer, own.reviewId).expect(400);
    const [r1, r2, r3] = [await createUserWithRole(ctx, 'CUSTOMER'), await createUserWithRole(ctx, 'CUSTOMER'), await createUserWithRole(ctx, 'CUSTOMER')];
    expect(body(await reportIt(r1, own.reviewId).expect(200))).toMatchObject({ status: 'PUBLISHED' });
    await reportIt(r1, own.reviewId).expect(200);
    expect(body(await reportIt(r2, own.reviewId, 'ABUSIVE').expect(200))).toMatchObject({ status: 'PUBLISHED' });
    expect(body(await reportIt(r3, own.reviewId).expect(200))).toMatchObject({ status: 'FLAGGED' });
    expect(await ctx.prisma.reviewReport.count({ where: { reviewId: own.reviewId } })).toBe(3);
    expect((body(await publicList(pharmacyId)) as { rating: { ratingCount: number } }).rating.ratingCount).toBe(0);
    await reportIt(r1, own.reviewId, 'NOT_A_REASON').expect(400);
  });

  it('moderates through Module 15: hide, restore, remove — logged, audited, reports resolved, the author told', async () => {
    const { orderId, pharmacyId } = await order(customer, 'DELIVERED');
    const own = body(await submit(customer, { orderId, rating: 5 }).expect(201)) as unknown as OwnReview;
    const reporter = await createUserWithRole(ctx, 'CUSTOMER');
    await reportIt(reporter, own.reviewId).expect(200);

    expect(body(await moderate(admin, own.reviewId, 'hide').expect(200))).toMatchObject({ status: 'HIDDEN', openReportCount: 0 });
    expect((body(await publicList(pharmacyId)) as { total: number }).total).toBe(0);
    expect(errorOf(await moderate(admin, own.reviewId, 'hide').expect(409)).code).toBe(ErrorCode.INVALID_MODERATION_TRANSITION);
    expect(body(await moderate(admin, own.reviewId, 'restore').expect(200))).toMatchObject({ status: 'PUBLISHED' });
    expect((body(await publicList(pharmacyId)) as { rating: { ratingCount: number } }).rating.ratingCount).toBe(1);
    await moderate(admin, own.reviewId, 'restore').expect(409);
    expect(body(await moderate(admin, own.reviewId, 'remove').expect(200))).toMatchObject({ status: 'REMOVED' });
    await moderate(admin, own.reviewId, 'restore').expect(409);
    await moderate(admin, own.reviewId, 'delete').expect(404);
    await moderate(admin, own.reviewId, 'hide', 'x').expect(400);

    const detail = body(await request(ctx.server).get(`/admin/reviews/${own.reviewId}`).set(...auth(admin.accessToken)).expect(200)) as { log: Array<{ action: string; moderatorUserId: string | null }> };
    expect(detail.log.map((l) => l.action)).toEqual(['REJECT', 'RESTORE', 'REMOVE']);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'REVIEW_MODERATED', actorUserId: admin.userId } })).toBe(3);
    const outbox = await ctx.prisma.outbox.findMany({ where: { eventType: 'reviews.review.moderated' } });
    expect(outbox).toHaveLength(3);
    // Removed: the author may no longer edit it.
    await request(ctx.server).patch(`/reviews/${own.reviewId}`).set(...auth(customer.accessToken)).send({ rating: 1 }).expect(409);
  });

  it('shows reported and held reviews, pending catalogue products and open content disputes in one flagged view', async () => {
    const held = await order(customer, 'DELIVERED');
    await submit(customer, { orderId: held.orderId, rating: 1, body: 'www.spam.example' }).expect(201);
    const clean = await order(customer, 'DELIVERED');
    await submit(customer, { orderId: clean.orderId, rating: 5 }).expect(201);
    const contentOrder = await order(customer, 'DELIVERED');
    await request(ctx.server)
      .post('/disputes')
      .set(...auth(customer.accessToken))
      .send({ orderId: contentOrder.orderId, type: 'CONTENT', subject: 'Wrong leaflet', description: 'The leaflet is for another product.' })
      .expect(201);

    const view = body(await request(ctx.server).get('/admin/moderation/flagged').set(...auth(admin.accessToken)).expect(200)) as {
      totals: Record<string, number>;
      items: Array<{ source: string; reasons: string[] }>;
    };
    expect(view.totals).toMatchObject({ REVIEW: 1, CONTENT_DISPUTE: 1 });
    expect(view.items.find((i) => i.source === 'REVIEW')?.reasons).toEqual(['AUTO_LINK']);
    expect(view.items.filter((i) => i.source === 'CONTENT_DISPUTE')).toHaveLength(1);
    const queue = body(await request(ctx.server).get('/admin/reviews?needsAttention=true').set(...auth(admin.accessToken)).expect(200)) as { total: number };
    expect(queue.total).toBe(1);
  });

  it('keeps moderation to administrators, writing to customers and reading public', async () => {
    for (const role of ['FINANCE_OFFICER', 'CUSTOMER_SUPPORT'] as const) {
      const caller = await createUserWithRole(ctx, role);
      await request(ctx.server).get('/admin/moderation/flagged').set(...auth(caller.accessToken)).expect(403);
    }
    await request(ctx.server).get('/admin/reviews').set(...auth(customer.accessToken)).expect(403);
    await request(ctx.server).get('/admin/moderation/flagged').expect(401);
    await request(ctx.server).post('/reviews').send({ orderId: randomUUID(), rating: 5 }).expect(401);
    const driver = await createUserWithRole(ctx, 'DRIVER');
    // Fixtures register every account as a customer first, so a driver here also holds review:create:own;
    // the gate that matters is the verified order.
    const theirs = await order(customer, 'DELIVERED');
    await submit(driver, { orderId: theirs.orderId, rating: 5 }).expect(422);
    await request(ctx.server).get(`/subjects/PHARMACY/${randomUUID()}/reviews`).expect(200);
  });
});
