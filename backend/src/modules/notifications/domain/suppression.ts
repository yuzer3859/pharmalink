import { createHash } from 'crypto';

/**
 * Destination suppression (module-13 Work 18). A destination the provider has told us must not be
 * mailed again — a permanent bounce or a spam complaint — is recorded in `suppression_list` and
 * checked before every later send, whatever the user's preference says: a preference can choose
 * not to receive, it cannot make a dead or complaining address safe to mail.
 *
 * The stored key is `sha256:<hex>` of the destination in Module 01's canonical form, never the
 * address itself. Deterministic, so the key computed from the address Resend reports in a webhook
 * equals the key computed from the address the contact port returns at send time.
 */
export function suppressionKeyOf(canonicalAddress: string): string {
  return `sha256:${createHash('sha256').update(canonicalAddress, 'utf8').digest('hex')}`;
}

/** Why a destination is suppressed — the `suppression_list.reason` values this module writes. */
export const SuppressionReason = {
  /** The provider reported a permanent bounce. */
  PERMANENT_BOUNCE: 'PERMANENT_BOUNCE',
  /** The recipient marked a message as spam. */
  COMPLAINT: 'COMPLAINT',
} as const;
export type SuppressionReason = (typeof SuppressionReason)[keyof typeof SuppressionReason];
