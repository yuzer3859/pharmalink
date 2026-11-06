import { Inject, Injectable } from '@nestjs/common';
import { ImpersonationSession, ImpersonationStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IPermissionResolver, PERMISSION_RESOLVER } from '../../../../shared/rbac/rbac.types';
import { IdentityErrors } from '../../domain/errors';
import { impersonationStartedEvent } from '../../domain/events';
import { AccessTokenClaims, ITokenService, TOKEN_SERVICE } from '../ports/token.service';
import {
  IIdentityImpersonationPort,
  IMPERSONATION_REDEEM_WINDOW_SECONDS,
  IMPERSONATION_TOKEN_TTL_SECONDS,
  ImpersonationSessionView,
  ImpersonationToken,
} from '../ports/inbound/identity-impersonation.port';

/** HTTP methods an impersonation token may use: it can look, never change. */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

/**
 * Support impersonation (Work 85; module-16 F-AD-08, backend/docs/impersonation.md).
 *
 * The rules, each enforced here in Module 01 rather than in Admin's routes:
 * - never a platform account (any PLATFORM-scope role: Admin, Super Admin, Finance, Support), never
 *   oneself, never an account that is not ACTIVE;
 * - only the administrator who asked may start the approved session, once, within the redeem window;
 * - the token lives 15 minutes, has no refresh token, carries both identities (`imp.act` = the
 *   administrator), and is refused for every non-GET request (`checkRequest`);
 * - every request made with it is audited with both identities; starting it notifies the account holder.
 */
@Injectable()
export class ImpersonationService implements IIdentityImpersonationPort {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TOKEN_SERVICE) private readonly tokens: ITokenService,
    @Inject(PERMISSION_RESOLVER) private readonly permissions: IPermissionResolver,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async assertImpersonable(targetUserId: string, requestedByUserId: string): Promise<void> {
    if (targetUserId === requestedByUserId) {
      throw IdentityErrors.impersonationNotAllowed('self');
    }
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user || user.deletedAt) {
      throw IdentityErrors.impersonationTargetNotFound();
    }
    if (user.status !== 'ACTIVE') {
      throw IdentityErrors.impersonationNotAllowed('not_active');
    }
    const platformRole = await this.prisma.userRole.findFirst({
      where: { userId: targetUserId, role: { scope: 'PLATFORM' } },
    });
    if (platformRole) {
      throw IdentityErrors.impersonationNotAllowed('platform_account');
    }
  }

  async authorize(input: {
    targetUserId: string;
    requestedByUserId: string;
    approvedByUserId: string;
    approvalId: string;
    reason: string;
  }): Promise<ImpersonationSessionView> {
    const existing = await this.prisma.impersonationSession.findUnique({ where: { approvalId: input.approvalId } });
    if (existing) {
      return toView(existing);
    }
    await this.assertImpersonable(input.targetUserId, input.requestedByUserId);
    if (input.approvedByUserId === input.requestedByUserId) {
      throw IdentityErrors.impersonationNotAllowed('self_approved');
    }
    const reason = (input.reason ?? '').trim();
    if (!reason) {
      throw IdentityErrors.validation('A reason is required to view an account as its holder.', { field: 'reason' });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.impersonationSession.create({
          data: {
            id: randomUUID(),
            targetUserId: input.targetUserId,
            requestedByUserId: input.requestedByUserId,
            approvedByUserId: input.approvedByUserId,
            approvalId: input.approvalId,
            reason: reason.slice(0, 500),
            redeemBy: new Date(Date.now() + IMPERSONATION_REDEEM_WINDOW_SECONDS * 1000),
          },
        });
        await this.audit.record(
          {
            actorUserId: input.approvedByUserId,
            action: 'IMPERSONATION_AUTHORIZED',
            resourceType: 'ImpersonationSession',
            resourceId: row.id,
            context: {
              targetUserId: row.targetUserId,
              requestedBy: row.requestedByUserId,
              approvedBy: row.approvedByUserId,
              approvalId: row.approvalId,
              reason: row.reason,
            },
          },
          tx,
        );
        return toView(row);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.impersonationSession.findUniqueOrThrow({ where: { approvalId: input.approvalId } });
        return toView(raced);
      }
      throw err;
    }
  }

  async start(sessionId: string, actorUserId: string, ip?: string | null): Promise<ImpersonationToken> {
    const session = await this.prisma.impersonationSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw IdentityErrors.impersonationSessionNotFound();
    }
    if (session.requestedByUserId !== actorUserId) {
      // Only the requester may use what was approved for them; the approver may not.
      throw IdentityErrors.impersonationNotAllowed('not_requester');
    }
    const now = new Date();
    if (session.status !== ImpersonationStatus.AUTHORIZED || session.redeemBy.getTime() <= now.getTime()) {
      throw IdentityErrors.impersonationSessionClosed(effectiveStatus(session, now));
    }
    // The target may have changed since approval (suspended, given a platform role).
    await this.assertImpersonable(session.targetUserId, actorUserId);
    const target = await this.prisma.user.findUniqueOrThrow({ where: { id: session.targetUserId } });
    const expiresAt = new Date(now.getTime() + IMPERSONATION_TOKEN_TTL_SECONDS * 1000);

    const started = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.impersonationSession.updateMany({
        where: { id: session.id, status: ImpersonationStatus.AUTHORIZED },
        data: { status: ImpersonationStatus.ACTIVE, startedAt: now, expiresAt },
      });
      if (count === 0) {
        throw IdentityErrors.impersonationSessionClosed('started');
      }
      await this.audit.record(
        {
          actorUserId,
          action: 'IMPERSONATION_STARTED',
          resourceType: 'ImpersonationSession',
          resourceId: session.id,
          context: { targetUserId: session.targetUserId, approvedBy: session.approvedByUserId, expiresAt: expiresAt.toISOString() },
          ip: ip ?? null,
        },
        tx,
      );
      await this.outbox.write(
        impersonationStartedEvent({ userId: session.targetUserId, sessionId: session.id, expiresAt: expiresAt.toISOString() }),
        tx as OutboxCapableClient,
      );
      return true;
    });
    if (!started) {
      throw IdentityErrors.impersonationSessionClosed('started');
    }

    const claims: AccessTokenClaims = {
      sub: target.id,
      permissions: await this.permissions.resolvePermissions(target.id),
      permVersion: target.permVersion,
      imp: { sid: session.id, act: actorUserId },
    };
    const issued = this.tokens.issueAccessToken(claims, IMPERSONATION_TOKEN_TTL_SECONDS);
    return { sessionId: session.id, accessToken: issued.token, expiresAt: issued.expiresAt, targetUserId: target.id };
  }

  async end(sessionId: string, actorUserId: string): Promise<ImpersonationSessionView> {
    const session = await this.prisma.impersonationSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw IdentityErrors.impersonationSessionNotFound();
    }
    if (session.requestedByUserId !== actorUserId && session.approvedByUserId !== actorUserId) {
      throw IdentityErrors.impersonationNotAllowed('not_party');
    }
    if (session.status === ImpersonationStatus.ENDED) {
      return toView(session);
    }
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.impersonationSession.updateMany({
        where: { id: session.id, status: { in: [ImpersonationStatus.AUTHORIZED, ImpersonationStatus.ACTIVE] } },
        data: { status: ImpersonationStatus.ENDED, endedAt: now, endedByUserId: actorUserId },
      });
      await this.audit.record(
        {
          actorUserId,
          action: 'IMPERSONATION_ENDED',
          resourceType: 'ImpersonationSession',
          resourceId: session.id,
          context: { targetUserId: session.targetUserId, previousStatus: session.status },
        },
        tx,
      );
      return toView(await tx.impersonationSession.findUniqueOrThrow({ where: { id: session.id } }));
    });
  }

  async list(
    filter: { requestedByUserId?: string; targetUserId?: string },
    page: number,
    size: number,
  ): Promise<{ items: ImpersonationSessionView[]; total: number; page: number; size: number }> {
    const where: Prisma.ImpersonationSessionWhereInput = {
      ...(filter.requestedByUserId ? { requestedByUserId: filter.requestedByUserId } : {}),
      ...(filter.targetUserId ? { targetUserId: filter.targetUserId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.impersonationSession.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.impersonationSession.count({ where }),
    ]);
    return { items: rows.map(toView), total, page, size };
  }

  /**
   * Called by `JwtAuthGuard` for every request carrying an `imp` claim. Refuses a write, a session
   * that is not ACTIVE or has run out, or a token whose target or actor does not match the session;
   * audits everything it lets through.
   */
  async checkRequest(claims: AccessTokenClaims, method: string, path: string): Promise<void> {
    const imp = claims.imp;
    if (!imp) return;
    if (!READ_ONLY_METHODS.has(method.toUpperCase())) {
      throw IdentityErrors.impersonationReadOnly();
    }
    const session = await this.prisma.impersonationSession.findUnique({ where: { id: imp.sid } });
    const now = Date.now();
    if (
      !session ||
      session.status !== ImpersonationStatus.ACTIVE ||
      !session.expiresAt ||
      session.expiresAt.getTime() <= now ||
      session.targetUserId !== claims.sub ||
      session.requestedByUserId !== imp.act
    ) {
      throw IdentityErrors.tokenInvalid();
    }
    await this.audit.record({
      actorUserId: imp.act,
      action: 'IMPERSONATED_REQUEST',
      resourceType: 'ImpersonationSession',
      resourceId: session.id,
      context: { targetUserId: claims.sub, method: method.toUpperCase(), path: path.split('?')[0] },
    });
  }
}

function effectiveStatus(row: ImpersonationSession, now: Date): ImpersonationStatus {
  if (row.status === ImpersonationStatus.AUTHORIZED && row.redeemBy.getTime() <= now.getTime()) {
    return ImpersonationStatus.EXPIRED;
  }
  if (row.status === ImpersonationStatus.ACTIVE && row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return ImpersonationStatus.EXPIRED;
  }
  return row.status;
}

function toView(row: ImpersonationSession): ImpersonationSessionView {
  return {
    id: row.id,
    targetUserId: row.targetUserId,
    requestedByUserId: row.requestedByUserId,
    approvedByUserId: row.approvedByUserId,
    approvalId: row.approvalId,
    reason: row.reason,
    status: effectiveStatus(row, new Date()),
    redeemBy: row.redeemBy,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
    endedAt: row.endedAt,
    endedByUserId: row.endedByUserId,
    createdAt: row.createdAt,
  };
}
