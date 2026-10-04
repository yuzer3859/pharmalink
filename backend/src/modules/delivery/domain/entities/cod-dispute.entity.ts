import { CodDisputeStatus } from '../enums';
import { DeliveryErrors } from '../errors';
import { MAX_CORRECTION_REASON_LENGTH } from './cod-correction.entity';

/**
 * The persisted shape of a COD dispute (§3.5 F-COD-01, §8's `cod_disputes`).
 *
 * `openedByUserId` and `resolvedByUserId` are Module 01 `users.id` values — PharmaLink operators,
 * never drivers. The driver whose collection is in question is named on the collection row; they
 * are the subject of a dispute, not a party who can close one.
 */
export interface CodDisputeProps {
  id: string;
  collectionId: string;
  /** Required. What is actually in question — the whole value of the record. */
  reason: string;
  status: CodDisputeStatus;
  openedByUserId: string;
  openedAt: Date;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  /** How it ended, in the operator's own words. Null while open. */
  resolutionNote: string | null;
}

export interface NewCodDisputeInput {
  id: string;
  collectionId: string;
  reason: string;
  openedByUserId: string;
  now?: Date;
}

/**
 * `CodDispute` (§3.5 F-COD-01, §5) — an open question about a COD collection, and how it ended.
 *
 * ## The follow-up the reconciliation work had nowhere to put
 *
 * `CodReconciliation` can record a `DISCREPANCY`, which is a finding somebody has to act on — and
 * until now there was no record of anybody acting. This is that record and deliberately nothing
 * more: who raised it, what about, who closed it, and what they concluded.
 *
 * ## Two states, and no case-management system
 *
 * `OPEN → RESOLVED`. No queue, no assignee, no SLA, no escalation path, no message thread, no
 * attachment — §5's "keep the lifecycle small and explicit", taken literally.
 *
 * Resolution is **free text rather than an outcome enum**, and that is a decision rather than
 * laziness. An enum would want values like `RECOVERED`, `WRITTEN_OFF` or `DRIVER_LIABLE`, and every
 * one of them answers the commercial question the design's Open Question 5 leaves open. Resolving a
 * dispute must be able to say what happened without the platform having decided who pays.
 *
 * ## It changes nothing about the money
 *
 * Opening or resolving a dispute writes no amount, moves no status on `cod_collections`, creates no
 * ledger entry, no payable, no settlement, no payout and no driver balance. A collection that was
 * `RECONCILED` stays `RECONCILED` while disputed — "somebody looked" remains true, and the dispute
 * says the looking is not finished.
 *
 * **And the discrepancy does not disappear.** Every variance the finance view reports is still
 * computed from the original rows; the dispute sits beside them.
 *
 * ## One transition, and it is write-once
 *
 * `resolve` is the only mutator on this class, and it refuses a dispute that is already resolved
 * rather than overwriting the first conclusion. The repository backs that with a compare-and-set on
 * `status`, so two operators closing the same dispute converge on one answer instead of the second
 * silently replacing the first.
 */
export class CodDispute {
  private constructor(private readonly props: CodDisputeProps) {}

  static open(input: NewCodDisputeInput): CodDispute {
    const props: CodDisputeProps = {
      id: requireText(input.id, 'id'),
      collectionId: requireText(input.collectionId, 'collectionId'),
      reason: requireReason(input.reason),
      status: CodDisputeStatus.OPEN,
      openedByUserId: requireText(input.openedByUserId, 'openedByUserId'),
      openedAt: input.now ?? new Date(),
      resolvedByUserId: null,
      resolvedAt: null,
      resolutionNote: null,
    };
    assertConsistent(props);
    return new CodDispute(props);
  }

  /** Rebuilds from persistence. Re-checks invariants: a row that violates them is a defect. */
  static rehydrate(props: CodDisputeProps): CodDispute {
    assertConsistent(props);
    return new CodDispute({ ...props });
  }

  /**
   * Closes the dispute, naming who closed it and what they concluded.
   *
   * Refuses an already-resolved dispute rather than restating it: a conclusion an operator can
   * overwrite is not a conclusion, and §10's "do not overwrite after creation" applies to the
   * ending as much as to the opening.
   */
  resolve(input: { resolvedByUserId: string; resolutionNote?: string | null; now?: Date }): CodDispute {
    if (this.props.status !== CodDisputeStatus.OPEN) {
      throw DeliveryErrors.codDisputeNotOpen(this.props.id, this.props.status);
    }
    const next: CodDisputeProps = {
      ...this.props,
      status: CodDisputeStatus.RESOLVED,
      resolvedByUserId: requireText(input.resolvedByUserId, 'resolvedByUserId'),
      resolvedAt: input.now ?? new Date(),
      resolutionNote: normalizeNote(input.resolutionNote),
    };
    assertConsistent(next);
    return new CodDispute(next);
  }

  get isOpen(): boolean {
    return this.props.status === CodDisputeStatus.OPEN;
  }

  toProps(): CodDisputeProps {
    return { ...this.props };
  }
}

/**
 * The invariants a dispute row must satisfy, on the way in and on the way out.
 *
 * The pair that matters: a resolved dispute must name who resolved it and when, and an open one
 * must name neither. Both halves are checked, so "resolved by nobody" and "open, but closed last
 * Tuesday" are unrepresentable rather than merely discouraged.
 */
function assertConsistent(props: CodDisputeProps): void {
  if (!Object.values(CodDisputeStatus).includes(props.status)) {
    throw DeliveryErrors.validation('status is not a known dispute status.', {
      field: 'status',
      value: props.status,
    });
  }

  const resolved = props.status === CodDisputeStatus.RESOLVED;
  const hasResolver = props.resolvedByUserId !== null && props.resolvedAt !== null;

  if (resolved && !hasResolver) {
    throw DeliveryErrors.validation('A resolved dispute must name who resolved it and when.', {
      field: 'resolvedByUserId',
    });
  }
  if (!resolved && (props.resolvedByUserId !== null || props.resolvedAt !== null)) {
    throw DeliveryErrors.validation('An open dispute cannot carry resolution details.', {
      field: 'resolvedByUserId',
    });
  }
  if (!resolved && props.resolutionNote !== null) {
    throw DeliveryErrors.validation('An open dispute cannot carry a resolution note.', {
      field: 'resolutionNote',
    });
  }
  if (props.resolutionNote !== null && props.resolutionNote.length > MAX_CORRECTION_REASON_LENGTH) {
    throw DeliveryErrors.validation(
      `resolutionNote must be at most ${MAX_CORRECTION_REASON_LENGTH} characters.`,
      { field: 'resolutionNote' },
    );
  }
}

function requireReason(value: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation('reason is required to open a dispute.', { field: 'reason' });
  }
  if (text.length > MAX_CORRECTION_REASON_LENGTH) {
    throw DeliveryErrors.validation(
      `reason must be at most ${MAX_CORRECTION_REASON_LENGTH} characters.`,
      { field: 'reason' },
    );
  }
  return text;
}

function normalizeNote(value?: string | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  return text.length === 0 ? null : text;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
