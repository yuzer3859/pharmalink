import { DeliveryErrors } from '../errors';

/** Longest remittance/reconciliation reference accepted. Generous for any slip number, bounded. */
export const MAX_REMITTANCE_REFERENCE_LENGTH = 128;

/** Longest operator note accepted. A sentence of explanation, not a case file. */
export const MAX_REMITTANCE_NOTE_LENGTH = 500;

/**
 * The persisted shape of a remittance (§3.5 F-COD-01, §8's `cod_remittances`).
 *
 * `confirmedByUserId` is a Module 01 `users.id` — the PharmaLink operator who accepted the money,
 * never a `driver_profiles.id`. That asymmetry with `CodCollectionProps.driverId` is the whole
 * point: the two rows name two different parties, from two different modules' identity spaces,
 * because they are two different assertions.
 *
 * `remittedAmount` is an ETB minor-unit integer (ADR-005).
 */
export interface CodRemittanceProps {
  id: string;
  /** `cod_collections.id` this handover covers. Unique — one confirmation per collection. */
  collectionId: string;
  /** What actually reached PharmaLink. Never assumed equal to the collected amount. */
  remittedAmount: number;
  currency: string;
  /** The generic PharmaLink-side handle for the handover. Shared across a batch. */
  reference: string;
  note: string | null;
  /** Module 01 `users.id` of the operator who confirmed it. */
  confirmedByUserId: string;
  /** When the money changed hands. */
  remittedAt: Date;
  /** When the platform recorded it. */
  recordedAt: Date;
}

/** What `CodRemittance.record` needs. */
export interface NewCodRemittanceInput {
  id: string;
  collectionId: string;
  remittedAmount: number;
  currency: string;
  reference: string;
  note?: string | null;
  confirmedByUserId: string;
  remittedAt?: Date | null;
  now?: Date;
}

/**
 * `CodRemittance` (§3.5 F-COD-01) — an authorized PharmaLink operator confirming that the driver
 * or delivery partner handed the collected money over.
 *
 * ## What it asserts, and the four things it does not
 *
 * It says the money reached **PharmaLink**. It does not say the pharmacy has been paid, does not
 * say the remittance has been checked against what was due, does not say any provider verified
 * anything, and does not create a financial obligation anywhere — those are, in order, Module 07's
 * settlement, `CodReconciliation`, an integration that does not exist yet, and Module 07's ledger.
 *
 * The money's route is customer → driver → PharmaLink → pharmacy. This is the second leg.
 *
 * ## Why the amount is recorded rather than assumed
 *
 * Nothing here defaults `remittedAmount` to what the driver declared collecting. A channel that
 * hands over less than it declared is exactly the case a remittance step exists to catch, and a
 * model that copied the collected figure would make that case unrepresentable — the books would
 * balance by construction and the difference would be discovered, if ever, by counting cash.
 *
 * The consequence is deliberate: the caller must state the figure, and a difference is preserved
 * as two numbers on two rows rather than resolved into one.
 *
 * ## Immutable
 *
 * **No mutator, as on `CodCollection` and for the same reason.** There is no way to restate a
 * remitted amount, change a reference or reassign the confirming operator: this row is the
 * platform's own evidence that it received cash from a channel, and evidence that can be edited is
 * not evidence. A correction is a later auditable adjustment under a workflow that decides who may
 * make one — not an overwrite here (§8).
 */
export class CodRemittance {
  private constructor(private readonly props: CodRemittanceProps) {}

  static record(input: NewCodRemittanceInput): CodRemittance {
    const now = input.now ?? new Date();
    const props: CodRemittanceProps = {
      id: requireText(input.id, 'id'),
      collectionId: requireText(input.collectionId, 'collectionId'),
      remittedAmount: input.remittedAmount,
      currency: requireText(input.currency, 'currency'),
      reference: requireText(input.reference, 'reference'),
      note: normalizeText(input.note),
      confirmedByUserId: requireText(input.confirmedByUserId, 'confirmedByUserId'),
      remittedAt: input.remittedAt ?? now,
      recordedAt: now,
    };
    assertConsistent(props);
    return new CodRemittance(props);
  }

  /** Rebuilds from persistence. Re-checks invariants: a row that violates them is a defect. */
  static rehydrate(props: CodRemittanceProps): CodRemittance {
    assertConsistent(props);
    return new CodRemittance({ ...props });
  }

  toProps(): CodRemittanceProps {
    return { ...this.props };
  }
}

/**
 * The invariants a remittance row must satisfy.
 *
 * A **zero remitted amount is legitimate**, exactly as a zero collection is: an operator recording
 * that a driver turned up with nothing is making a real and useful statement, and refusing it would
 * leave the platform with no record of the one handover it most needs one for. What is refused is a
 * negative amount, which would be PharmaLink handing money *to* the channel — not a remittance at
 * all, and not something this table should be able to express.
 *
 * The reference is **required**, unlike a collection's `providerReference`. A collection can
 * honestly have no reference, because cash has none; a remittance is an act PharmaLink performed
 * and can always name — and without a handle, §19's "group a day's cash by handover" has nothing
 * to group on.
 */
function assertConsistent(props: CodRemittanceProps): void {
  if (!Number.isInteger(props.remittedAmount) || props.remittedAmount < 0) {
    throw DeliveryErrors.validation(
      'remittedAmount must be a non-negative integer (minor units).',
      { field: 'remittedAmount', value: props.remittedAmount },
    );
  }

  if (props.reference.length > MAX_REMITTANCE_REFERENCE_LENGTH) {
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

/** Trims, and turns an empty or absent value into `null`. */
export function normalizeText(value?: string | null): string | null {
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
