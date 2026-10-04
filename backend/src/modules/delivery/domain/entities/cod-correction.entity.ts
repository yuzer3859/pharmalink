import { CodCorrectionType } from '../enums';
import { DeliveryErrors } from '../errors';

/** Longest reason accepted. Room for a real explanation, bounded against a case file. */
export const MAX_CORRECTION_REASON_LENGTH = 1000;

/** Longest corrected reference accepted. Matches `cod_remittances.reference`. */
export const MAX_CORRECTION_REFERENCE_LENGTH = 128;

export const MIN_CORRECTION_IDEMPOTENCY_KEY_LENGTH = 8;
export const MAX_CORRECTION_IDEMPOTENCY_KEY_LENGTH = 128;

/** Printable ASCII, no whitespace — a replay key travels in logs and unique indexes. */
const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;

/**
 * The persisted shape of a COD correction (§3.5 F-COD-01, §8's `cod_corrections`).
 *
 * `createdByUserId` is a Module 01 `users.id` — the PharmaLink operator. Never a
 * `driver_profiles.id`, and the asymmetry with `CodCollectionProps.driverId` is deliberate: the
 * person who recorded the money and the person who may correct the record are never the same
 * authority.
 *
 * Amounts are ETB minor-unit integers (ADR-005). There is no `currency`: no correction type can
 * change one, and the currency of the money being discussed is on the row this one references.
 */
export interface CodCorrectionProps {
  id: string;
  /** `cod_collections.id` — always set, whatever the correction is about. */
  collectionId: string;
  /** `cod_remittances.id` when the correction is about the handover. */
  remittanceId: string | null;
  /** `cod_reconciliations.id` when the correction is about the finding. */
  reconciliationId: string | null;
  type: CodCorrectionType;
  /** What the record said, and what it should have said. Both null unless the type is monetary. */
  originalAmount: number | null;
  correctedAmount: number | null;
  /** The same pair for a mistyped transaction number, deposit slip or batch label. */
  originalReference: string | null;
  correctedReference: string | null;
  /** Required. An unexplained change to a financial record is what this table exists to prevent. */
  reason: string;
  /** The caller-supplied replay key, unique across the table. */
  idempotencyKey: string;
  /** Module 01 `users.id` of the operator who recorded it. */
  createdByUserId: string;
  createdAt: Date;
}

export interface NewCodCorrectionInput {
  id: string;
  collectionId: string;
  remittanceId?: string | null;
  reconciliationId?: string | null;
  type: CodCorrectionType;
  originalAmount?: number | null;
  correctedAmount?: number | null;
  originalReference?: string | null;
  correctedReference?: string | null;
  reason: string;
  idempotencyKey: string;
  createdByUserId: string;
  now?: Date;
}

/**
 * `CodCorrection` (§3.5 F-COD-01) — what a COD record *should* have said, recorded beside it.
 *
 * ## A compensating record, not an edit
 *
 * The three historical COD tables are evidence: a driver's declaration about a customer's money, an
 * operator's confirmation that it arrived, and an operator's finding about the two. None has an
 * update path anywhere in this module, because evidence that can be edited is not evidence.
 *
 * That guarantee is only worth keeping if a genuine mistake has somewhere to go. This is that
 * somewhere, and it takes the shape the project already uses for a fact that cannot be undone —
 * Module 07's `refunds` against a payment it cannot un-charge. The original stays exactly as
 * written; the correction sits next to it saying what was wrong and why.
 *
 * ## It changes nothing
 *
 * Not `collectedAmount`, not `expectedAmount`, not `remittedAmount`, not a method, a reference, a
 * timestamp or a status. Not the collection's position in `COLLECTED → REMITTED → RECONCILED`. No
 * ledger entry, payable, settlement or payout — and **no discrepancy disappears**: every variance
 * the finance view reports is still computed from the original rows, with corrections listed
 * alongside. `original fact + correction` is the history; the correction is not a replacement for
 * the fact.
 *
 * ## Immutable, structurally
 *
 * **No mutator on this class, and no `update` on its repository** — the same discipline
 * `CodCollection`, `CodRemittance` and `CodReconciliation` hold. A correction that could itself be
 * corrected would put the module back where it started; a mistaken correction is answered by
 * another correction, which is why they are a list rather than a slot.
 *
 * ## The value pair is checked against the type
 *
 * `RECORDING_MISTAKE` must carry amounts and must not carry references. `REFERENCE_CORRECTION` must
 * carry references and must not carry amounts. The other two carry neither and rest on `reason`.
 * Enforced here rather than left to a caller, because a `RECORDING_MISTAKE` with no numbers is a
 * correction that says a figure was wrong without saying what it should be — worse than no record
 * at all, since it would look like one.
 *
 * A correction whose original and corrected values are identical is refused for the same reason: it
 * asserts that a mistake was made and then describes no change.
 */
export class CodCorrection {
  private constructor(private readonly props: CodCorrectionProps) {}

  static record(input: NewCodCorrectionInput): CodCorrection {
    const props: CodCorrectionProps = {
      id: requireText(input.id, 'id'),
      collectionId: requireText(input.collectionId, 'collectionId'),
      remittanceId: normalizeText(input.remittanceId),
      reconciliationId: normalizeText(input.reconciliationId),
      type: requireType(input.type),
      originalAmount: input.originalAmount ?? null,
      correctedAmount: input.correctedAmount ?? null,
      originalReference: normalizeText(input.originalReference),
      correctedReference: normalizeText(input.correctedReference),
      reason: requireReason(input.reason),
      idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
      createdByUserId: requireText(input.createdByUserId, 'createdByUserId'),
      createdAt: input.now ?? new Date(),
    };
    assertConsistent(props);
    return new CodCorrection(props);
  }

  /** Rebuilds from persistence. Re-checks invariants: a row that violates them is a defect. */
  static rehydrate(props: CodCorrectionProps): CodCorrection {
    assertConsistent(props);
    return new CodCorrection({ ...props });
  }

  /**
   * `correctedAmount − originalAmount`, or `null` for a non-monetary correction.
   *
   * Derived rather than stored, and **not** applied to anything. It says how far the record was
   * out; it does not say that the collection's variance has changed, because the collection's
   * variance is a fact about what was written down at the time and stays what it was.
   */
  get amountDelta(): number | null {
    if (this.props.originalAmount === null || this.props.correctedAmount === null) {
      return null;
    }
    return this.props.correctedAmount - this.props.originalAmount;
  }

  toProps(): CodCorrectionProps {
    return { ...this.props };
  }
}

/** `correctedAmount − originalAmount` for a persisted row, or `null`. */
export function amountDeltaOf(props: CodCorrectionProps): number | null {
  if (props.originalAmount === null || props.correctedAmount === null) {
    return null;
  }
  return props.correctedAmount - props.originalAmount;
}

/**
 * The invariants a correction row must satisfy.
 *
 * A **zero amount is legitimate on either side** — correcting a mis-keyed 24,500 down to 0 records
 * that the driver in fact collected nothing, which is a real and important statement. What is
 * refused is a negative amount, which no collection or remittance can produce.
 */
function assertConsistent(props: CodCorrectionProps): void {
  for (const [field, value] of [
    ['originalAmount', props.originalAmount],
    ['correctedAmount', props.correctedAmount],
  ] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw DeliveryErrors.validation(
        `${field} must be a non-negative integer (minor units).`,
        { field, value },
      );
    }
  }

  for (const [field, value] of [
    ['originalReference', props.originalReference],
    ['correctedReference', props.correctedReference],
  ] as const) {
    if (value !== null && value.length > MAX_CORRECTION_REFERENCE_LENGTH) {
      throw DeliveryErrors.validation(
        `${field} must be at most ${MAX_CORRECTION_REFERENCE_LENGTH} characters.`,
        { field },
      );
    }
  }

  const hasAmounts = props.originalAmount !== null || props.correctedAmount !== null;
  const hasReferences = props.originalReference !== null || props.correctedReference !== null;

  switch (props.type) {
    case CodCorrectionType.RECORDING_MISTAKE:
      // Both halves, or the record says a figure was wrong without saying what it should be.
      if (props.originalAmount === null || props.correctedAmount === null) {
        throw DeliveryErrors.validation(
          'A recording-mistake correction must carry both originalAmount and correctedAmount.',
          { field: 'correctedAmount', type: props.type },
        );
      }
      if (hasReferences) {
        throw DeliveryErrors.validation(
          'A recording-mistake correction cannot carry a reference. Record a separate reference correction.',
          { field: 'correctedReference', type: props.type },
        );
      }
      if (props.originalAmount === props.correctedAmount) {
        throw DeliveryErrors.validation(
          'A correction must change the value it corrects.',
          { field: 'correctedAmount', type: props.type },
        );
      }
      break;

    case CodCorrectionType.REFERENCE_CORRECTION:
      if (props.correctedReference === null) {
        throw DeliveryErrors.validation(
          'A reference correction must carry the corrected reference.',
          { field: 'correctedReference', type: props.type },
        );
      }
      if (hasAmounts) {
        throw DeliveryErrors.validation(
          'A reference correction cannot carry an amount. Record a separate recording-mistake correction.',
          { field: 'correctedAmount', type: props.type },
        );
      }
      if (props.originalReference === props.correctedReference) {
        throw DeliveryErrors.validation('A correction must change the value it corrects.', {
          field: 'correctedReference',
          type: props.type,
        });
      }
      break;

    case CodCorrectionType.RECONCILIATION_MISTAKE:
      // The finding was reached in error. What was wrong about it is `reason`'s job — there is no
      // "corrected outcome", because re-deciding the outcome is a reconciliation, and a
      // reconciliation is computed from amounts rather than asserted by an operator.
      if (props.reconciliationId === null) {
        throw DeliveryErrors.validation(
          'A reconciliation-mistake correction must name the reconciliation it corrects.',
          { field: 'reconciliationId', type: props.type },
        );
      }
      if (hasAmounts || hasReferences) {
        throw DeliveryErrors.validation(
          'A reconciliation-mistake correction carries no value pair; state what was wrong in the reason.',
          { field: 'type', type: props.type },
        );
      }
      break;

    case CodCorrectionType.ADMINISTRATIVE_ADJUSTMENT:
      // A note of record. Deliberately the only type that changes no stated value — and equally
      // deliberately not a place to put an amount, which is what would turn it into a write-off.
      if (hasAmounts || hasReferences) {
        throw DeliveryErrors.validation(
          'An administrative adjustment carries no value pair; state the adjustment in the reason.',
          { field: 'type', type: props.type },
        );
      }
      break;

    default:
      throw DeliveryErrors.validation('Unknown correction type.', { type: props.type });
  }
}

function requireType(type: CodCorrectionType): CodCorrectionType {
  if (!Object.values(CodCorrectionType).includes(type)) {
    throw DeliveryErrors.validation('type is not a known correction type.', {
      field: 'type',
      value: type,
    });
  }
  return type;
}

function requireReason(value: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation('reason is required for a correction.', { field: 'reason' });
  }
  if (text.length > MAX_CORRECTION_REASON_LENGTH) {
    throw DeliveryErrors.validation(
      `reason must be at most ${MAX_CORRECTION_REASON_LENGTH} characters.`,
      { field: 'reason' },
    );
  }
  return text;
}

/**
 * Module 08's own bounds for a replay key, matching Module 06's `CheckoutInput.idempotencyKey` and
 * Module 07's `IdempotencyKey` value object — an own copy per ADR-002, never a cross-module import,
 * so a key valid at one boundary is valid at this one.
 */
function requireIdempotencyKey(value: string): string {
  const text = (value ?? '').trim();
  if (
    text.length < MIN_CORRECTION_IDEMPOTENCY_KEY_LENGTH ||
    text.length > MAX_CORRECTION_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw DeliveryErrors.validation(
      `idempotencyKey must be between ${MIN_CORRECTION_IDEMPOTENCY_KEY_LENGTH} and ${MAX_CORRECTION_IDEMPOTENCY_KEY_LENGTH} characters.`,
      { field: 'idempotencyKey' },
    );
  }
  if (!PRINTABLE_NO_SPACE.test(text)) {
    throw DeliveryErrors.validation(
      'idempotencyKey must contain only printable, non-whitespace ASCII characters.',
      { field: 'idempotencyKey' },
    );
  }
  return text;
}

function normalizeText(value?: string | null): string | null {
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
