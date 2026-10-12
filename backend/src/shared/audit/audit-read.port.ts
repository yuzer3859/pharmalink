export const AUDIT_READ_PORT = Symbol('AUDIT_READ_PORT');

/**
 * One stored audit entry, exactly as `audit_logs` holds it (module-01 schema, ADR-012). Every
 * field is a column; nothing is derived or added. `prevHash`/`hash` are the chain's own
 * metadata, carried so a reader can see that the entry participates in it.
 */
export interface AuditRecordView {
  id: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  context: unknown;
  ip: string | null;
  prevHash: string | null;
  hash: string;
  createdAt: Date;
}

/**
 * What a reader may narrow by — each one a column `audit_logs` has, and two of them indexed
 * (`actorUserId`; `resourceType, resourceId`). There is no filter over `context`: it is free-form
 * JSON written by every module, with no shared shape to search.
 */
export interface AuditSearchFilter {
  /** Exact action name, e.g. `CONFIG_CHANGED` or `identity.verification.approved`. */
  action?: string;
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Inclusive lower bound on `createdAt`. */
  from?: Date;
  /** Exclusive upper bound on `createdAt`. */
  to?: Date;
}

/** One resource's entries of one action — every field an exact match (module-16 Work 33). */
export interface AuditResourceTrailFilter {
  action: string;
  resourceType: string;
  resourceId: string;
}

export interface AuditPage {
  items: AuditRecordView[];
  total: number;
  page: number;
  size: number;
}

/**
 * The read side of the shared hash-chained audit log — the boundary that did not exist until
 * Module 16's audit explorer needed one. Module 03 reads its own products' status-change trail
 * through it too (module-16 Work 33's review history).
 *
 * `AuditService` is write-only by design ("NEVER expose an update/delete path for this table"),
 * and this port keeps it that way: it is a separate contract with two reads and nothing else. No
 * consumer of it can append, alter or remove an entry, and the hash chain is never touched —
 * `prevHash` and `hash` come back exactly as stored, for the reader to inspect.
 *
 * Bound in `AuditModule`, which is global, so any module may inject `AUDIT_READ_PORT`: Module 16's
 * audit explorer does, under `audit:read:any`, and Module 03's review history reads one action of
 * one product (`trailOf`), under `catalog:manage:any`.
 */
export interface IAuditReadPort {
  /** Newest first, `id` descending as a tiebreaker, so a page boundary is stable. */
  search(filter: AuditSearchFilter, page: number, size: number): Promise<AuditPage>;
  findById(id: string): Promise<AuditRecordView | null>;
  /**
   * Every entry of `filter.action` for exactly one resource, **oldest first** (`createdAt`, then `id`
   * as a stable tiebreaker) — one resource's own history, unpaged. Served by the `(resourceType,
   * resourceId)` index; nothing else is loaded.
   */
  trailOf(filter: AuditResourceTrailFilter): Promise<AuditRecordView[]>;
}
