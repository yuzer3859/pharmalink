import { CodReconciliationOutcome } from '../enums';
import { DeliveryErrors } from '../errors';
import {
  MAX_REMITTANCE_NOTE_LENGTH,
  MAX_REMITTANCE_REFERENCE_LENGTH,
  normalizeText,
} from './cod-remittance.entity';

/**
 * The persisted shape of a reconciliation (§3.5 F-COD-01, §8's `cod_reconciliations`).
 *
 * Deliberately carries **no amounts**. Expected, collected and remitted already sit on two
 * immutable rows this one points at, and a copy here could only ever be a second answer to a
 * question that already has one. `outcome` is the exception — see the class comment.
 */
export interface CodReconciliationProps {
  id: string;
  /** `cod_collections.id` reconciled. Unique — one reconciliation per collection. */
  collectionId: string;
  /** The platform's recorded finding. Computed from the amounts, never supplied by a caller. */
  outcome: CodReconciliationOutcome;
  /** An optional generic handle for the reconciliation run itself. */
  reference: string | null;
  /** What the operator wants the next reader to know, where the outcome is a difference. */
  note: string | null;
  /** Module 01 `users.id` of the operator who reconciled it. */
  reconciledByUserId: string;
  reconciledAt: Date;
}

/** What `CodReconciliation.record` needs. `outcome` is resolved by policy before it arrives. */
export interface NewCodReconciliationInput {
  id: string;
  collectionId: string;
  outcome: CodReconciliationOutcome;
  reference?: string | null;
  note?: string | null;
  reconciledByUserId: string;
  now?: Date;
}

/**
 * `CodReconciliation` (§3.5 F-COD-01, §9.5's `/admin/delivery/cod-reconciliation`) — PharmaLink
 * checking a remittance against the collection it was supposed to cover, and recording what it
 * found.
 *
 * ## The last leg this module knows about
 *
 * `RECONCILED` means an authorized operator compared what was due, what the driver declared and
 * what arrived, and wrote the finding down. It does **not** mean the pharmacy has been paid: that
 * is Module 07's settlement, computed from the order rather than from this table, and §16 keeps
 * `settled` out of the delivery lifecycle entirely. Nor does it mean a provider verified an
 * electronic reference — nothing in this repository can do that yet.
 *
 * ## A discrepancy is a finding, not a failure
 *
 * Both outcomes write a row. `DISCREPANCY` is the reconciliation succeeding and reporting a
 * difference, and recording it is the entire reason the step exists: a mismatch that is merely
 * *refused* leaves the platform with no record that anybody looked, while a mismatch recorded as
 * `ACCEPTED` is a fake successful payment — the one thing §6 names outright.
 *
 * What it deliberately does not do is decide **who absorbs the difference**. Recovering it from the
 * driver, absorbing it as a platform cost, chasing the customer, writing it off — every one of
 * those is a commercial and possibly disciplinary decision nobody has taken, and the design's Open
 * Question 5 leaves the whole cash-handling policy open. The row makes the difference visible and
 * un-loseable and stops there.
 *
 * ## The outcome is computed, never supplied
 *
 * `CodCollectionPolicy.classifyReconciliation` derives it from the three amounts, and the command
 * passes what the policy returned. There is no path — no DTO field, no override, no configuration
 * flag — by which an operator can mark a shortfall `ACCEPTED`. A reconciliation that could say the
 * books balanced when they did not would make every other guarantee in this module decorative.
 *
 * ## Immutable
 *
 * No mutator, no repository update, no route with a write verb that reaches it. §8: reconciliation
 * history is not deleted and not overwritten. A finding an operator later disagrees with is
 * answered by a new adjustment record under a workflow that decides who may make one.
 */
export class CodReconciliation {
  private constructor(private readonly props: CodReconciliationProps) {}

  static record(input: NewCodReconciliationInput): CodReconciliation {
    const props: CodReconciliationProps = {
      id: requireText(input.id, 'id'),
      collectionId: requireText(input.collectionId, 'collectionId'),
      outcome: requireOutcome(input.outcome),
      reference: normalizeText(input.reference),
      note: normalizeText(input.note),
      reconciledByUserId: requireText(input.reconciledByUserId, 'reconciledByUserId'),
      reconciledAt: input.now ?? new Date(),
    };
    assertConsistent(props);
    return new CodReconciliation(props);
  }

  /** Rebuilds from persistence. Re-checks invariants: a row that violates them is a defect. */
  static rehydrate(props: CodReconciliationProps): CodReconciliation {
    assertConsistent(props);
    return new CodReconciliation({ ...props });
  }

  /** Whether this reconciliation found the money it was checking. */
  get isAccepted(): boolean {
    return this.props.outcome === CodReconciliationOutcome.ACCEPTED;
  }

  toProps(): CodReconciliationProps {
    return { ...this.props };
  }
}

function assertConsistent(props: CodReconciliationProps): void {
  if (props.reference !== null && props.reference.length > MAX_REMITTANCE_REFERENCE_LENGTH) {
    throw DeliveryErrors.validation(
      `reference must be at most ${MAX_REMITTANCE_REFERENCE_LENGTH} characters.`,
      { field: 'reference' },
    );
  }
  if (props.note !== null && props.note.length > MAX_REMITTANCE_NOTE_LENGTH) {
    throw DeliveryErrors.validation(
      `note must be at most ${MAX_REMITTANCE_NOTE_LENGTH} characters.`,
      { field: 'note' },
    );
  }
}

function requireOutcome(outcome: CodReconciliationOutcome): CodReconciliationOutcome {
  if (!Object.values(CodReconciliationOutcome).includes(outcome)) {
    throw DeliveryErrors.validation('outcome must be ACCEPTED or DISCREPANCY.', {
      field: 'outcome',
      value: outcome,
    });
  }
  return outcome;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
