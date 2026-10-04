import { AuditPage, AuditRecordView } from '../../../../shared/audit/audit-read.port';
import { AuditEntryView } from '../../application/queries/get-audit-entry.query';

/**
 * One audit entry as the explorer reports it — an explicit allow-list of the columns
 * `audit_logs` has.
 *
 * `context` is returned as written. It is the writing module's own record of what happened, and
 * every writer in this repository already keeps secrets out of it (identifiers are masked before
 * they are recorded; document references, Fayda numbers, tokens and password hashes are never
 * written). There is no project-wide masking convention on read, so none is invented here; if one
 * is ever decided, this mapper is where it applies.
 */
export interface AuditEntryResponse {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  context: unknown;
  ip: string | null;
  createdAt: string;
  /** The chain's own metadata, as stored. Never recomputed into the row, never rewritten. */
  chain: { prevHash: string | null; hash: string };
}

export interface AuditListResponse {
  items: AuditEntryResponse[];
  total: number;
  page: number;
  size: number;
}

export interface AuditEntryDetailResponse extends AuditEntryResponse {
  chain: { prevHash: string | null; hash: string; hashValid: boolean };
}

export function toAuditEntryResponse(entry: AuditRecordView): AuditEntryResponse {
  return {
    id: entry.id,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    actorUserId: entry.actorUserId,
    context: entry.context ?? null,
    ip: entry.ip,
    createdAt: entry.createdAt.toISOString(),
    chain: { prevHash: entry.prevHash, hash: entry.hash },
  };
}

export function toAuditListResponse(page: AuditPage): AuditListResponse {
  return {
    items: page.items.map(toAuditEntryResponse),
    total: page.total,
    page: page.page,
    size: page.size,
  };
}

export function toAuditEntryDetailResponse(entry: AuditEntryView): AuditEntryDetailResponse {
  return {
    ...toAuditEntryResponse(entry),
    chain: { prevHash: entry.prevHash, hash: entry.hash, hashValid: entry.hashValid },
  };
}
