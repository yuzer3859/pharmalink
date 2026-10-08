import { SuppressionPage, SuppressionView } from '../../../notifications/application/ports/inbound/notification-suppression-admin.port';

/** One suppression for an operator — no address, no full hash, no provider detail. */
export interface SuppressionResponse {
  id: string;
  channel: string;
  reason: string | null;
  /** `sha256:` + 8 hex digits — to tell rows apart, not to look anything up. */
  destinationFingerprint: string | null;
  createdAt: string;
}

export interface SuppressionListResponse {
  items: SuppressionResponse[];
  total: number;
  page: number;
  size: number;
}

// Explicit allow-list, never a spread.
export function toSuppressionResponse(v: SuppressionView): SuppressionResponse {
  return {
    id: v.id,
    channel: v.channel,
    reason: v.reason,
    destinationFingerprint: v.destinationFingerprint,
    createdAt: v.createdAt.toISOString(),
  };
}

export function toSuppressionListResponse(p: SuppressionPage): SuppressionListResponse {
  return { items: p.items.map(toSuppressionResponse), total: p.total, page: p.page, size: p.size };
}
