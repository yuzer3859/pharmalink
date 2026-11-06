import type { ImpersonationStatus } from '@prisma/client';

export const IDENTITY_IMPERSONATION_PORT = Symbol('IDENTITY_IMPERSONATION_PORT');

/** The permission to ask for, approve and use a "view as" session (Work 85). ADMIN; SUPER_ADMIN by wildcard. */
export const SUPPORT_IMPERSONATE_PERMISSION = 'support:impersonate:any';

/** How long a started session's read-only token lives. No refresh exists. */
export const IMPERSONATION_TOKEN_TTL_SECONDS = 15 * 60;
/** How long an approved session waits for its requester to start it. */
export const IMPERSONATION_REDEEM_WINDOW_SECONDS = 15 * 60;

export interface ImpersonationSessionView {
  id: string;
  targetUserId: string;
  requestedByUserId: string;
  approvedByUserId: string;
  approvalId: string;
  reason: string;
  /** Effective: an AUTHORIZED session past `redeemBy`, or an ACTIVE one past `expiresAt`, reads EXPIRED. */
  status: ImpersonationStatus;
  redeemBy: Date;
  startedAt: Date | null;
  expiresAt: Date | null;
  endedAt: Date | null;
  endedByUserId: string | null;
  createdAt: Date;
}

export interface ImpersonationToken {
  sessionId: string;
  accessToken: string;
  /** Unix seconds. */
  expiresAt: number;
  targetUserId: string;
}

/**
 * Module 01's support impersonation (Work 85, module-16 F-AD-08). Admin's maker-checker executor
 * calls `authorize` after a second administrator approved; the requester then `start`s it and gets a
 * short-lived, read-only access token for the target account.
 */
export interface IIdentityImpersonationPort {
  /** Refuses a target that may never be impersonated (missing, not active, or holding a platform role). */
  assertImpersonable(targetUserId: string, requestedByUserId: string): Promise<void>;
  authorize(input: {
    targetUserId: string;
    requestedByUserId: string;
    approvedByUserId: string;
    approvalId: string;
    reason: string;
  }): Promise<ImpersonationSessionView>;
  start(sessionId: string, actorUserId: string, ip?: string | null): Promise<ImpersonationToken>;
  end(sessionId: string, actorUserId: string): Promise<ImpersonationSessionView>;
  list(filter: { requestedByUserId?: string; targetUserId?: string }, page: number, size: number): Promise<{
    items: ImpersonationSessionView[];
    total: number;
    page: number;
    size: number;
  }>;
}
