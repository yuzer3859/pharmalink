import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

/**
 * Identity domain event types — the inter-module contract (see
 * architecture/00-domain-event-catalog.md §1, Module 01). Canonical dotted names; payloads carry
 * identifiers and non-sensitive fields only. Written to the outbox in the same transaction as the
 * state change.
 */
export const IdentityEventType = {
  UserRegistered: 'identity.user.registered',
  UserVerified: 'identity.user.verified',
  AccountSuspended: 'identity.account.suspended',
  AccountReactivated: 'identity.account.reactivated',
  ProviderApproved: 'identity.provider.approved',
  ProviderRejected: 'identity.provider.rejected',
  LicenseExpired: 'identity.license.expired',
  SessionsRevoked: 'identity.sessions.revoked',
  RefreshTokenReuseDetected: 'identity.refresh.reuse_detected',
  // Work 85: a support administrator started a read-only "view as" session on the account.
  ImpersonationStarted: 'identity.impersonation.started',
} as const;

/** Work 85. Who it was is in the audit log, not here: the account holder is told that, not by whom. */
export interface ImpersonationStartedPayload {
  userId: string;
  sessionId: string;
  expiresAt: string;
}

export function impersonationStartedEvent(
  payload: ImpersonationStartedPayload,
): DomainEvent<ImpersonationStartedPayload> {
  return createDomainEvent({
    type: IdentityEventType.ImpersonationStarted,
    aggregateType: 'User',
    aggregateId: payload.userId,
    payload,
  });
}

export interface UserRegisteredPayload {
  userId: string;
  role: string;
  locale: string;
}

export interface UserVerifiedPayload {
  userId: string;
  method: 'PHONE' | 'EMAIL' | 'FAYDA';
}

export interface SessionsRevokedPayload {
  userId: string;
  reason: string;
}

export interface AccountStatusChangedPayload {
  userId: string;
  actorUserId: string;
  reason?: string;
}

export interface ProviderDecisionPayload {
  userId: string;
  organizationId: string | null;
  verificationRequestId: string;
  verificationType: string;
  reviewerId: string;
  reason?: string;
}

export interface LicenseExpiredPayload {
  userId: string;
  organizationId: string | null;
  verificationRequestId: string;
  verificationType: string;
  expiredAt: string;
}

export interface RefreshReuseDetectedPayload {
  userId: string;
  familyId: string;
}

export function userRegisteredEvent(
  payload: UserRegisteredPayload,
): DomainEvent<UserRegisteredPayload> {
  return createDomainEvent({
    type: IdentityEventType.UserRegistered,
    aggregateType: 'User',
    aggregateId: payload.userId,
    payload,
  });
}

export function userVerifiedEvent(
  payload: UserVerifiedPayload,
): DomainEvent<UserVerifiedPayload> {
  return createDomainEvent({
    type: IdentityEventType.UserVerified,
    aggregateType: 'User',
    aggregateId: payload.userId,
    payload,
  });
}

export function sessionsRevokedEvent(
  payload: SessionsRevokedPayload,
): DomainEvent<SessionsRevokedPayload> {
  return createDomainEvent({
    type: IdentityEventType.SessionsRevoked,
    aggregateType: 'User',
    aggregateId: payload.userId,
    payload,
  });
}

export function accountSuspendedEvent(
  payload: AccountStatusChangedPayload,
): DomainEvent<AccountStatusChangedPayload> {
  return createDomainEvent({
    type: IdentityEventType.AccountSuspended,
    aggregateType: 'User',
    aggregateId: payload.userId,
    payload,
  });
}

export function accountReactivatedEvent(
  payload: AccountStatusChangedPayload,
): DomainEvent<AccountStatusChangedPayload> {
  return createDomainEvent({
    type: IdentityEventType.AccountReactivated,
    aggregateType: 'User',
    aggregateId: payload.userId,
    payload,
  });
}

export function providerApprovedEvent(
  payload: ProviderDecisionPayload,
): DomainEvent<ProviderDecisionPayload> {
  return createDomainEvent({
    type: IdentityEventType.ProviderApproved,
    aggregateType: 'User',
    aggregateId: payload.userId,
    payload,
  });
}

export function providerRejectedEvent(
  payload: ProviderDecisionPayload,
): DomainEvent<ProviderDecisionPayload> {
  return createDomainEvent({
    type: IdentityEventType.ProviderRejected,
    aggregateType: 'User',
    aggregateId: payload.userId,
    payload,
  });
}

export function licenseExpiredEvent(
  payload: LicenseExpiredPayload,
): DomainEvent<LicenseExpiredPayload> {
  return createDomainEvent({
    type: IdentityEventType.LicenseExpired,
    aggregateType: 'User',
    aggregateId: payload.userId,
    payload,
  });
}

export function refreshReuseDetectedEvent(
  payload: RefreshReuseDetectedPayload,
): DomainEvent<RefreshReuseDetectedPayload> {
  return createDomainEvent({
    type: IdentityEventType.RefreshTokenReuseDetected,
    aggregateType: 'User',
    aggregateId: payload.userId,
    payload,
  });
}
