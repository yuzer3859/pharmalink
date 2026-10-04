import { createHash } from 'crypto';

/** The fields that are bound into the tamper-evident hash chain. */
export interface AuditHashInput {
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  context?: unknown;
  ip?: string | null;
  createdAt: string; // ISO timestamp, bound into the hash
}

/** A stored/loaded chain entry, used for verification. */
export interface AuditChainEntry extends AuditHashInput {
  prevHash: string | null;
  hash: string;
}

/**
 * Deterministic JSON stringify with sorted keys so the hash is stable regardless of property
 * insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Compute the entry hash: SHA-256 over the previous hash (genesis = empty string) concatenated
 * with the canonical serialization of this entry's bound fields. Pure + deterministic so it can
 * be unit-tested and independently re-verified.
 */
export function computeEntryHash(prevHash: string | null, input: AuditHashInput): string {
  const canonical = canonicalize({
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    context: input.context ?? null,
    ip: input.ip ?? null,
    createdAt: input.createdAt,
  });
  return createHash('sha256')
    .update(`${prevHash ?? ''}|${canonical}`)
    .digest('hex');
}

/**
 * Verify an ordered list of chain entries: each prevHash must match the predecessor's hash and
 * each hash must equal the recomputed value. Returns the index of the first broken link, or -1
 * if the whole chain is intact.
 */
export function verifyChain(entries: AuditChainEntry[]): number {
  let expectedPrev: string | null = null;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if ((e.prevHash ?? null) !== expectedPrev) {
      return i;
    }
    if (computeEntryHash(e.prevHash ?? null, e) !== e.hash) {
      return i;
    }
    expectedPrev = e.hash;
  }
  return -1;
}
