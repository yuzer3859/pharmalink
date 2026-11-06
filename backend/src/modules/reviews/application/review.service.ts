import { Inject, Injectable } from '@nestjs/common';
import { Prisma, ReviewStatus, ReviewTargetType } from '@prisma/client';
import { AuditService } from '../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  IOrderReviewEligibilityPort,
  ORDER_REVIEW_ELIGIBILITY_PORT,
} from '../../orders/application/ports/inbound/order-review-eligibility.port';
import { reviewModeratedEvent } from '../domain/events';
import {
  aggregate,
  autoFlags,
  EDIT_WINDOW_DAYS,
  MODERATION_MOVES,
  ModerationMove,
  normalizeContent,
  REPORTS_TO_FLAG,
  ReportReason,
  REVIEWABLE_ORDER_STATUSES,
  ReviewContent,
  ReviewErrors,
  withinEditWindow,
} from '../domain/review-policy';
import {
  IReviewModerationPort,
  ModerationLogView,
  ModerationReviewView,
  ModerationSearch,
} from './ports/inbound/review-moderation.port';

type Tx = Prisma.TransactionClient;
type ReviewRow = Prisma.ReviewGetPayload<{ include: { reports: true; moderationLogs: true } }>;

export interface Actor {
  userId: string;
  ip?: string | null;
}

/** A published review as anyone may see it: no author, no order, no moderation detail. */
export interface PublicReviewView {
  reviewId: string;
  rating: number;
  title: string | null;
  body: string | null;
  /** Always true: only a customer who received the order can review (BRULE-45). */
  verifiedPurchase: true;
  edited: boolean;
  publishedAt: Date | null;
}

/** The author's own view of their review. */
export interface OwnReviewView extends PublicReviewView {
  targetType: string;
  targetId: string;
  orderId: string;
  status: ReviewStatus;
  editableUntil: Date;
}

const toPublic = (r: ReviewRow | Prisma.ReviewGetPayload<object>): PublicReviewView => ({
  reviewId: r.id,
  rating: r.rating,
  title: r.title,
  body: r.body,
  verifiedPurchase: true,
  edited: r.editCount > 0,
  publishedAt: r.publishedAt,
});

const toModeration = (r: ReviewRow): ModerationReviewView => {
  const open = r.reports.filter((x) => !x.resolved);
  return {
    reviewId: r.id,
    authorUserId: r.authorUserId,
    targetType: r.targetType,
    targetId: r.targetId,
    orderId: r.transactionId,
    rating: r.rating,
    title: r.title,
    body: r.body,
    status: r.status,
    openReportCount: open.length,
    reportReasons: [...new Set(open.map((x) => x.reason))].sort(),
    autoFlags: [...new Set(r.moderationLogs.filter((l) => l.isAutomated && l.action === 'FLAG').flatMap((l) => (l.reason ?? '').split(',').filter(Boolean)))].sort(),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
};

const WITH = { reports: true, moderationLogs: true } as const;
const PUBLIC_STATUS: ReviewStatus = 'PUBLISHED';

/**
 * Module 15, minimum (Work 91; architecture/module-15-reviews-ratings.md, backend/docs/reviews.md):
 * verified-purchase reviews of the pharmacy that fulfilled an order, reports, automatic holding by
 * content rules, moderation (through `IReviewModerationPort`) and the rating aggregate.
 */
@Injectable()
export class ReviewService implements IReviewModerationPort {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ORDER_REVIEW_ELIGIBILITY_PORT) private readonly orders: IOrderReviewEligibilityPort,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** BRULE-45 / 47: the author's own received order, a pharmacy that fulfilled it, once. */
  async submit(input: { orderId: string; pharmacyId?: string } & ReviewContent, actor: Actor, now = new Date()): Promise<OwnReviewView> {
    const content = normalizeContent(input);
    const order = await this.orders.findOrder(input.orderId);
    if (!order || order.customerUserId !== actor.userId) throw ReviewErrors.notEligible('NOT_YOUR_ORDER');
    if (!REVIEWABLE_ORDER_STATUSES.includes(order.status)) throw ReviewErrors.notEligible('NOT_RECEIVED');
    const pharmacies = [...new Set(order.fulfillments.filter((f) => f.status !== 'CANCELLED').map((f) => f.pharmacyId))];
    const pharmacyId = input.pharmacyId ?? (pharmacies.length === 1 ? pharmacies[0] : undefined);
    if (!pharmacyId) throw ReviewErrors.validation('This order was fulfilled by more than one pharmacy: name the one you review.');
    if (!pharmacies.includes(pharmacyId)) throw ReviewErrors.notEligible('PHARMACY_DID_NOT_FULFIL');

    const flags = autoFlags(content);
    const status: ReviewStatus = flags.length ? 'FLAGGED' : 'PUBLISHED';
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.review.create({
          data: {
            authorUserId: actor.userId,
            targetType: 'PHARMACY',
            targetId: pharmacyId,
            transactionType: 'ORDER',
            transactionId: order.orderId,
            ...content,
            status,
            publishedAt: status === 'PUBLISHED' ? now : null,
          },
          include: WITH,
        });
        if (flags.length) await tx.moderationLog.create({ data: { reviewId: created.id, action: 'FLAG', reason: flags.join(','), isAutomated: true } });
        await this.recompute(tx, 'PHARMACY', pharmacyId);
        await this.audit.record(
          { actorUserId: actor.userId, action: 'REVIEW_SUBMITTED', resourceType: 'Review', resourceId: created.id, context: { targetType: 'PHARMACY', targetId: pharmacyId, orderId: order.orderId, rating: content.rating, status, autoFlags: flags }, ip: actor.ip ?? null },
          tx,
        );
        return created;
      });
      return this.toOwn(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw ReviewErrors.alreadyReviewed();
      throw err;
    }
  }

  /** The author edits within the window; the content rules run again. Hidden or removed reviews stay as they are. */
  async edit(reviewId: string, input: ReviewContent, actor: Actor, now = new Date()): Promise<OwnReviewView> {
    const content = normalizeContent(input);
    const existing = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!existing || existing.authorUserId !== actor.userId || existing.deletedAt) throw ReviewErrors.notFound();
    if (!withinEditWindow(existing.createdAt, now)) throw ReviewErrors.editWindowClosed();
    if (existing.status === 'HIDDEN' || existing.status === 'REMOVED') throw ReviewErrors.notEditable(existing.status);
    const flags = autoFlags(content);
    // An edit that trips a rule is held; one that clears it does not release a review held by reports.
    const heldByReports = existing.status === 'FLAGGED' && (await this.openReports(existing.id)) >= REPORTS_TO_FLAG;
    const status: ReviewStatus = flags.length || heldByReports ? 'FLAGGED' : 'PUBLISHED';
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.review.update({
        where: { id: reviewId },
        data: { ...content, status, editCount: { increment: 1 }, publishedAt: status === 'PUBLISHED' ? (existing.publishedAt ?? now) : existing.publishedAt },
        include: WITH,
      });
      if (flags.length) await tx.moderationLog.create({ data: { reviewId, action: 'FLAG', reason: flags.join(','), isAutomated: true } });
      await this.recompute(tx, existing.targetType, existing.targetId);
      await this.audit.record(
        { actorUserId: actor.userId, action: 'REVIEW_EDITED', resourceType: 'Review', resourceId: reviewId, context: { rating: content.rating, status, autoFlags: flags }, ip: actor.ip ?? null },
        tx,
      );
      return updated;
    });
    return this.toOwn(row);
  }

  async mine(userId: string): Promise<OwnReviewView[]> {
    const rows = await this.prisma.review.findMany({ where: { authorUserId: userId, deletedAt: null }, orderBy: { createdAt: 'desc' }, include: WITH });
    return rows.map((r) => this.toOwn(r));
  }

  /** Published reviews of a subject, newest first, with its aggregate. Public. */
  async forSubject(targetType: 'PHARMACY', targetId: string, page: number, size: number) {
    const where = { targetType, targetId, status: PUBLIC_STATUS, deletedAt: null };
    const [rows, total, agg] = await Promise.all([
      this.prisma.review.findMany({ where, orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * size, take: size }),
      this.prisma.review.count({ where }),
      this.rating(targetType, targetId),
    ]);
    return { items: rows.map(toPublic), total, page, size, rating: agg };
  }

  async rating(targetType: 'PHARMACY', targetId: string) {
    const row = await this.prisma.ratingAggregate.findUnique({ where: { targetType_targetId: { targetType, targetId } } });
    return {
      ratingCount: row?.ratingCount ?? 0,
      ratingAvg: row?.ratingAvg ?? 0,
      distribution: (row?.distribution as Record<string, number> | null) ?? aggregate([]).distribution,
      lastReviewAt: row?.lastReviewAt ?? null,
    };
  }

  /**
   * Someone reports a review (F-MOD-02). One open report per person per review (a repeat is
   * answered with the first). The third distinct open report holds a published review as FLAGGED.
   */
  async report(reviewId: string, input: { reason: ReportReason; detail?: string | null }, actor: Actor): Promise<{ reported: true; status: ReviewStatus }> {
    const review = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!review || review.deletedAt || (review.status !== 'PUBLISHED' && review.status !== 'FLAGGED')) throw ReviewErrors.notFound();
    if (review.authorUserId === actor.userId) throw ReviewErrors.validation('You cannot report your own review.');
    const status = await this.prisma.$transaction(async (tx) => {
      const already = await tx.reviewReport.findFirst({ where: { reviewId, reporterUserId: actor.userId, resolved: false } });
      if (already) return review.status;
      await tx.reviewReport.create({ data: { reviewId, reporterUserId: actor.userId, reason: input.reason, detail: input.detail?.trim() || null } });
      const reporters = await tx.reviewReport.findMany({ where: { reviewId, resolved: false }, distinct: ['reporterUserId'], select: { reporterUserId: true } });
      let next = review.status;
      if (review.status === 'PUBLISHED' && reporters.length >= REPORTS_TO_FLAG) {
        next = 'FLAGGED';
        await tx.review.update({ where: { id: reviewId }, data: { status: next } });
        await tx.moderationLog.create({ data: { reviewId, action: 'FLAG', reason: 'REPORTS', isAutomated: true } });
        await this.recompute(tx, review.targetType, review.targetId);
      }
      await this.audit.record(
        { actorUserId: actor.userId, action: 'REVIEW_REPORTED', resourceType: 'Review', resourceId: reviewId, context: { reason: input.reason, status: next }, ip: actor.ip ?? null },
        tx,
      );
      return next;
    });
    return { reported: true, status };
  }

  // ---- IReviewModerationPort (Module 16) -------------------------------------------------------

  async list(filter: ModerationSearch, page: number, size: number): Promise<{ items: ModerationReviewView[]; total: number }> {
    const where: Prisma.ReviewWhereInput = {
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.needsAttention ? { OR: [{ status: 'FLAGGED' }, { reports: { some: { resolved: false } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.review.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * size, take: size, include: WITH }),
      this.prisma.review.count({ where }),
    ]);
    return { items: rows.map(toModeration), total };
  }

  async get(reviewId: string): Promise<{ review: ModerationReviewView; log: ModerationLogView[] } | null> {
    const row = await this.prisma.review.findUnique({ where: { id: reviewId }, include: WITH });
    if (!row || row.deletedAt) return null;
    return {
      review: toModeration(row),
      log: [...row.moderationLogs]
        .sort((a, b) => +a.createdAt - +b.createdAt)
        .map((l) => ({ action: l.action, reason: l.reason, isAutomated: l.isAutomated, moderatorUserId: l.moderatorUserId, createdAt: l.createdAt })),
    };
  }

  /** Hide, remove or restore (BRULE-46): logged, audited, reports resolved, the author told. */
  async moderate(input: { reviewId: string; move: ModerationMove; reason: string; moderatorUserId: string; ip?: string | null }): Promise<ModerationReviewView> {
    const reason = input.reason.trim();
    if (reason.length < 3) throw ReviewErrors.validation('Give a reason of at least 3 characters.');
    const rule = MODERATION_MOVES[input.move];
    const row = await this.prisma.$transaction(async (tx) => {
      const review = await tx.review.findUnique({ where: { id: input.reviewId } });
      if (!review || review.deletedAt) throw ReviewErrors.notFound();
      if (!(rule.from as readonly string[]).includes(review.status)) throw ReviewErrors.invalidMove(review.status, input.move);
      // Compare-and-set on the status, so two moderators cannot both apply a move to the same state.
      const changed = await tx.review.updateMany({
        where: { id: review.id, status: review.status },
        data: { status: rule.to, ...(rule.to === 'PUBLISHED' && !review.publishedAt ? { publishedAt: new Date() } : {}) },
      });
      if (changed.count !== 1) throw ReviewErrors.invalidMove(review.status, input.move);
      await tx.reviewReport.updateMany({ where: { reviewId: review.id, resolved: false }, data: { resolved: true } });
      await tx.moderationLog.create({ data: { reviewId: review.id, moderatorUserId: input.moderatorUserId, action: rule.action, reason } });
      await this.recompute(tx, review.targetType, review.targetId);
      await this.audit.record(
        { actorUserId: input.moderatorUserId, action: 'REVIEW_MODERATED', resourceType: 'Review', resourceId: review.id, context: { move: input.move, from: review.status, to: rule.to, reason }, ip: input.ip ?? null },
        tx,
      );
      await this.outbox.write(reviewModeratedEvent({ reviewId: review.id, userId: review.authorUserId, move: input.move, status: rule.to }), tx as OutboxCapableClient);
      return tx.review.findUniqueOrThrow({ where: { id: review.id }, include: WITH });
    });
    return toModeration(row);
  }

  // ---- internals --------------------------------------------------------------------------------

  private openReports(reviewId: string) {
    return this.prisma.reviewReport.count({ where: { reviewId, resolved: false } });
  }

  /** The aggregate from the subject's published reviews, rebuilt exactly in the same transaction. */
  private async recompute(tx: Tx, targetType: ReviewTargetType, targetId: string): Promise<void> {
    const published = await tx.review.findMany({ where: { targetType, targetId, status: 'PUBLISHED', deletedAt: null }, select: { rating: true, publishedAt: true } });
    const agg = aggregate(published.map((p) => p.rating));
    const lastReviewAt = published.reduce<Date | null>((latest, p) => (p.publishedAt && (!latest || p.publishedAt > latest) ? p.publishedAt : latest), null);
    await tx.ratingAggregate.upsert({
      where: { targetType_targetId: { targetType, targetId } },
      create: { targetType, targetId, ...agg, lastReviewAt },
      update: { ...agg, lastReviewAt },
    });
  }

  private toOwn(r: ReviewRow): OwnReviewView {
    return {
      ...toPublic(r),
      targetType: r.targetType,
      targetId: r.targetId,
      orderId: r.transactionId,
      status: r.status,
      editableUntil: new Date(r.createdAt.getTime() + EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000),
    };
  }
}
