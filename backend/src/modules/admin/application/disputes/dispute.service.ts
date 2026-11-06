import { Inject, Injectable } from '@nestjs/common';
import { DisputePriority, DisputeStatus, DisputeType, Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import {
  FINANCE_OVERSIGHT_PORT,
  IFinanceOversightPort,
} from '../../../payment/application/ports/inbound/finance-oversight.port';
import {
  IOrderOwnershipReadPort,
  ORDER_OWNERSHIP_READ_PORT,
} from '../../../orders/application/ports/inbound/order-ownership-read.port';
import { AdminErrors } from '../../domain/errors';
import { disputeOpenedEvent, disputeUpdatedEvent } from '../../domain/events';
import { ApprovalStatus } from '../../domain/maker-checker/approval-request';
import {
  APPROVAL_REQUEST_REPOSITORY,
  IApprovalRequestRepository,
} from '../../domain/maker-checker/approval-request.repository';
import {
  DISPUTE_REPOSITORY,
  DisputeCaseRow,
  DisputeMessageRow,
  PrismaDisputeRepository,
} from '../../infrastructure/persistence/prisma-dispute.repository';
import { MakerCheckerGate } from '../maker-checker/maker-checker-gate.service';
import { ADMIN_UNIT_OF_WORK, IAdminUnitOfWork } from '../ports/unit-of-work.port';

export { DisputePriority, DisputeStatus, DisputeType };

/** Work 86: working cases needs this; ADMIN and FINANCE_OFFICER. */
export const DISPUTE_MANAGE_PERMISSION = 'dispute:manage:any';
/** Work 86: a customer opening and following their own disputes. */
export const DISPUTE_OWN_PERMISSION = 'dispute:create:own';
/** A refund resolution is Work 84's refund action, so it needs the refund permission too. */
const REFUND_PERMISSION = 'finance:refund:any';
export const REFUND_HIGH_VALUE_ACTION = 'REFUND_HIGH_VALUE';

/**
 * Response targets per priority (module-16 open question 5; the owner asked for the recommended
 * answer). Overdue cases are flagged, not escalated automatically: escalation is a human decision.
 */
export const DISPUTE_SLA_HOURS: Record<DisputePriority, number> = {
  URGENT: 4,
  HIGH: 24,
  NORMAL: 72,
  LOW: 168,
};

const OPEN_STATUSES: DisputeStatus[] = [
  DisputeStatus.OPEN,
  DisputeStatus.INVESTIGATING,
  DisputeStatus.ESCALATED,
  DisputeStatus.RESOLUTION_PENDING,
];

/** The working transitions an administrator may make by hand (resolve and close have their own rules). */
const MANUAL_TRANSITIONS: Partial<Record<DisputeStatus, DisputeStatus[]>> = {
  OPEN: [DisputeStatus.INVESTIGATING, DisputeStatus.ESCALATED],
  INVESTIGATING: [DisputeStatus.ESCALATED],
  ESCALATED: [DisputeStatus.INVESTIGATING],
  RESOLVED: [DisputeStatus.CLOSED],
};

export const MAX_DISPUTE_TEXT = 2000;

export interface Actor {
  userId: string;
  permissions: readonly string[];
  ip?: string | null;
}

export type ResolutionAction = 'NO_ACTION' | 'REFUND';

export interface DisputeView {
  case: DisputeCaseRow;
  overdue: boolean;
}

function slaDue(openedAt: Date, priority: DisputePriority): Date {
  return new Date(openedAt.getTime() + DISPUTE_SLA_HOURS[priority] * 3600_000);
}

function caseNumber(at: Date): string {
  const day = at.toISOString().slice(0, 10).replace(/-/g, '');
  const tail = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  return `DSP-${day}-${tail}`;
}

function text(value: string | undefined | null, field: string, min = 1): string {
  const v = (value ?? '').trim();
  if (v.length < min || v.length > MAX_DISPUTE_TEXT) {
    throw AdminErrors.validation(`${field} must be ${min} to ${MAX_DISPUTE_TEXT} characters.`, { field });
  }
  return v;
}

export function toDisputeView(row: DisputeCaseRow, now = new Date()): DisputeView {
  return { case: row, overdue: OPEN_STATUSES.includes(row.status) && row.slaDueAt.getTime() < now.getTime() };
}

/**
 * General disputes (Work 86; module-16 §7, §9.6, §11.4, BRULE-50; backend/docs/disputes.md).
 *
 * One case per complaint about a customer's order, its delivery or its payment. Intake by the customer
 * (their own order only) or by an administrator on their behalf; a thread with internal notes; working
 * states, priority-based SLA, assignment; and a resolution recorded once. A refund resolution is Work
 * 84's `REFUND_HIGH_VALUE` action through the maker-checker gate — a large one waits for a second
 * finance officer and the case completes when that refund is carried out. Every change is audited, and
 * the customer is told about every change they can see.
 */
@Injectable()
export class DisputeService {
  constructor(
    @Inject(DISPUTE_REPOSITORY) private readonly disputes: PrismaDisputeRepository,
    @Inject(ADMIN_UNIT_OF_WORK) private readonly uow: IAdminUnitOfWork,
    @Inject(ORDER_OWNERSHIP_READ_PORT) private readonly ownership: IOrderOwnershipReadPort,
    @Inject(FINANCE_OVERSIGHT_PORT) private readonly finance: IFinanceOversightPort,
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly approvals: IApprovalRequestRepository,
    private readonly gate: MakerCheckerGate,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async open(
    input: { orderId: string; type: DisputeType; subject: string; description: string; priority?: DisputePriority },
    actor: Actor,
    asAdmin: boolean,
  ): Promise<DisputeView> {
    if (!Object.values(DisputeType).includes(input.type)) {
      throw AdminErrors.validation('Unknown dispute type.', { field: 'type' });
    }
    const subject = text(input.subject, 'subject', 3).slice(0, 200);
    const description = text(input.description, 'description', 10);
    const order = await this.ownership.findOrder(input.orderId);
    // A customer may only complain about their own order; someone else's reads as absent.
    if (!order || (!asAdmin && order.customerUserId !== actor.userId)) {
      throw AdminErrors.disputeOrderNotFound();
    }
    const priority = asAdmin && input.priority ? input.priority : DisputePriority.NORMAL;
    const openedAt = new Date();

    const created = await this.uow.run(async (tx) => {
      const row = await this.disputes.create(
        {
          id: randomUUID(),
          caseNumber: caseNumber(openedAt),
          type: input.type,
          transactionType: 'ORDER',
          transactionId: order.orderId,
          complainantUserId: order.customerUserId,
          openedByUserId: actor.userId,
          subject,
          description,
          priority,
          slaDueAt: slaDue(openedAt, priority),
          openedAt,
        },
        tx,
      );
      if (!row) return null;
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'DISPUTE_OPENED',
          resourceType: 'DisputeCase',
          resourceId: row.id,
          context: { caseNumber: row.caseNumber, type: row.type, orderId: row.transactionId, byAdmin: asAdmin, priority },
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.outbox.write(
        disputeOpenedEvent({ caseId: row.id, caseNumber: row.caseNumber, type: row.type, orderId: row.transactionId, userId: row.complainantUserId }),
        tx as OutboxCapableClient,
      );
      return row;
    });
    if (!created) {
      const existing = await this.disputes.findOpenFor(order.orderId, input.type);
      throw AdminErrors.disputeAlreadyOpen(existing?.caseNumber ?? '');
    }
    return toDisputeView(created);
  }

  list(filter: Parameters<PrismaDisputeRepository['search']>[0], page: number, size: number) {
    return this.disputes.search(filter, page, size).then((r) => ({ ...r, items: r.items.map((row) => toDisputeView(row)) }));
  }

  /** An administrator's view: every message, internal notes included. */
  async getForAdmin(id: string): Promise<{ view: DisputeView; messages: DisputeMessageRow[] }> {
    const row = await this.disputes.findById(id);
    if (!row) throw AdminErrors.disputeNotFound();
    return { view: toDisputeView(row), messages: await this.disputes.messages(id, true) };
  }

  /** The complainant's view: their own case only, without internal notes. */
  async getForCustomer(id: string, userId: string): Promise<{ view: DisputeView; messages: DisputeMessageRow[] }> {
    const row = await this.disputes.findById(id);
    if (!row || row.complainantUserId !== userId) throw AdminErrors.disputeNotFound();
    return { view: toDisputeView(row), messages: await this.disputes.messages(id, false) };
  }

  async addMessage(id: string, actor: Actor, asAdmin: boolean, body: string, internal: boolean): Promise<DisputeMessageRow> {
    const message = text(body, 'body');
    const row = await this.disputes.findById(id);
    if (!row || (!asAdmin && row.complainantUserId !== actor.userId)) throw AdminErrors.disputeNotFound();
    if (row.status === DisputeStatus.CLOSED) throw AdminErrors.disputeInvalidTransition(row.status, 'message');
    const isInternal = asAdmin && internal;
    return this.uow.run(async (tx) => {
      const created = await this.disputes.addMessage(
        { id: randomUUID(), caseId: id, senderUserId: actor.userId, senderRole: asAdmin ? 'ADMIN' : 'CUSTOMER', body: message, internal: isInternal },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'DISPUTE_MESSAGE_ADDED',
          resourceType: 'DisputeCase',
          resourceId: id,
          context: { messageId: created.id, internal: isInternal, byAdmin: asAdmin },
        },
        tx,
      );
      if (asAdmin && !isInternal) {
        await this.notify(row, 'MESSAGE', tx);
      }
      return created;
    });
  }

  async update(
    id: string,
    actor: Actor,
    change: { status?: DisputeStatus; priority?: DisputePriority; assignedAdminId?: string | null; reason?: string | null },
  ): Promise<DisputeView> {
    const row = await this.disputes.findById(id);
    if (!row) throw AdminErrors.disputeNotFound();
    const data: Prisma.DisputeCaseUncheckedUpdateManyInput = {};
    if (change.status && change.status !== row.status) {
      if (!(MANUAL_TRANSITIONS[row.status] ?? []).includes(change.status)) {
        throw AdminErrors.disputeInvalidTransition(row.status, change.status);
      }
      data.status = change.status;
      if (change.status === DisputeStatus.CLOSED) data.closedAt = new Date();
    }
    if (change.priority && change.priority !== row.priority) {
      data.priority = change.priority;
      data.slaDueAt = slaDue(row.openedAt, change.priority);
    }
    if (change.assignedAdminId !== undefined) data.assignedAdminId = change.assignedAdminId;
    if (Object.keys(data).length === 0) return toDisputeView(row);

    const updated = await this.uow.run(async (tx) => {
      const moved = await this.disputes.transition(id, [row.status], data, tx);
      if (!moved) throw AdminErrors.disputeInvalidTransition('changed', String(change.status ?? 'update'));
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'DISPUTE_UPDATED',
          resourceType: 'DisputeCase',
          resourceId: id,
          context: {
            from: { status: row.status, priority: row.priority, assignedAdminId: row.assignedAdminId },
            to: { status: moved.status, priority: moved.priority, assignedAdminId: moved.assignedAdminId },
            reason: change.reason ?? null,
          },
          ip: actor.ip ?? null,
        },
        tx,
      );
      if (moved.status !== row.status) await this.notify(moved, 'STATUS', tx);
      return moved;
    });
    return toDisputeView(updated);
  }

  /**
   * Records the outcome once. `NO_ACTION` resolves at once. `REFUND` submits Work 84's refund action:
   * carried out now → RESOLVED with the refund; waiting for a second officer → RESOLUTION_PENDING
   * until the approval runs (`completeRefund`). A rejected, failed or expired approval leaves the
   * case resolvable again.
   */
  async resolve(
    id: string,
    actor: Actor,
    input: { action: ResolutionAction; notes: string; amount?: number | null; destination?: 'ORIGINAL' | 'WALLET'; idempotencyKey: string },
  ): Promise<DisputeView> {
    const notes = text(input.notes, 'notes', 3);
    const row = await this.disputes.findById(id);
    if (!row) throw AdminErrors.disputeNotFound();
    if (!OPEN_STATUSES.includes(row.status)) throw AdminErrors.disputeInvalidTransition(row.status, DisputeStatus.RESOLVED);
    if (row.status === DisputeStatus.RESOLUTION_PENDING && row.pendingApprovalId) {
      const pending = await this.approvals.findById(row.pendingApprovalId);
      if (pending && (pending.status === ApprovalStatus.PENDING || pending.status === ApprovalStatus.APPROVED)) {
        throw AdminErrors.disputeInvalidTransition(row.status, DisputeStatus.RESOLVED);
      }
    }

    if (input.action === 'NO_ACTION') {
      return this.finish(row, actor, { action: 'NO_ACTION', notes });
    }
    if (input.action !== 'REFUND') {
      throw AdminErrors.validation('action must be NO_ACTION or REFUND.', { field: 'action' });
    }
    if (!hasPermission(actor.permissions, REFUND_PERMISSION)) {
      throw AdminErrors.approvalPermissionMissing(REFUND_PERMISSION);
    }
    // The order's refundable payment, from Module 07 (`orders.paymentId` is not maintained).
    const payments = await this.finance.listPayments({ orderId: row.transactionId }, 1, 20);
    const payment = payments.items.find((p) => p.status === 'CAPTURED' || p.status === 'PARTIALLY_REFUNDED');
    if (!payment) {
      throw AdminErrors.validation('This order has no captured payment to refund.', { orderId: row.transactionId });
    }
    const result = await this.gate.submit({
      actionType: REFUND_HIGH_VALUE_ACTION,
      payload: {
        paymentId: payment.paymentId,
        amount: input.amount ?? null,
        reason: `Dispute ${row.caseNumber}: ${notes}`.slice(0, 500),
        destination: input.destination ?? 'ORIGINAL',
        disputeCaseId: row.id,
      },
      makerUserId: actor.userId,
      makerPermissions: actor.permissions,
      idempotencyKey: input.idempotencyKey,
      reason: `Dispute ${row.caseNumber}`,
      ip: actor.ip ?? null,
    });
    if (result.outcome === 'EXECUTED') {
      return this.finish(row, actor, { action: 'REFUND', notes, refund: result.result });
    }
    const pending = await this.uow.run(async (tx) => {
      const moved = await this.disputes.transition(
        id,
        OPEN_STATUSES,
        {
          status: DisputeStatus.RESOLUTION_PENDING,
          pendingApprovalId: result.approval.id,
          resolution: { action: 'REFUND', notes, approvalId: result.approval.id } as Prisma.InputJsonValue,
        },
        tx,
      );
      if (!moved) throw AdminErrors.disputeInvalidTransition('changed', DisputeStatus.RESOLUTION_PENDING);
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'DISPUTE_RESOLUTION_PENDING',
          resourceType: 'DisputeCase',
          resourceId: id,
          context: { approvalId: result.approval.id, notes },
        },
        tx,
      );
      return moved;
    });
    return toDisputeView(pending);
  }

  /** Called by the refund action once a second officer's approval carried the refund out. */
  async completeRefund(caseId: string, approvalId: string, checkerUserId: string, refund: Record<string, unknown>): Promise<void> {
    const row = await this.disputes.findById(caseId);
    if (!row || row.status !== DisputeStatus.RESOLUTION_PENDING || row.pendingApprovalId !== approvalId) return;
    const draft = (row.resolution as { notes?: string } | null) ?? {};
    await this.finish(row, { userId: checkerUserId, permissions: [] }, { action: 'REFUND', notes: draft.notes ?? '', refund, approvalId });
  }

  private async finish(row: DisputeCaseRow, actor: Actor, resolution: Record<string, unknown>): Promise<DisputeView> {
    const done = await this.uow.run(async (tx) => {
      const moved = await this.disputes.transition(
        row.id,
        OPEN_STATUSES,
        {
          status: DisputeStatus.RESOLVED,
          resolvedAt: new Date(),
          pendingApprovalId: null,
          resolution: { ...resolution, resolvedBy: actor.userId } as Prisma.InputJsonValue,
        },
        tx,
      );
      if (!moved) throw AdminErrors.disputeInvalidTransition('changed', DisputeStatus.RESOLVED);
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'DISPUTE_RESOLVED',
          resourceType: 'DisputeCase',
          resourceId: row.id,
          context: { caseNumber: row.caseNumber, resolution },
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.notify(moved, 'STATUS', tx);
      return moved;
    });
    return toDisputeView(done);
  }

  private notify(row: DisputeCaseRow, change: 'STATUS' | 'MESSAGE', tx: unknown) {
    return this.outbox.write(
      disputeUpdatedEvent({ caseId: row.id, caseNumber: row.caseNumber, userId: row.complainantUserId, status: row.status, change }),
      tx as OutboxCapableClient,
    );
  }
}
