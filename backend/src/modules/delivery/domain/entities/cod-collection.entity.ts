import { CodCollectionMethod, CodCollectionStatus } from '../enums';
import { DeliveryErrors } from '../errors';

/** Longest provider reference accepted. Generous for any transaction id, bounded against abuse. */
export const MAX_PROVIDER_REFERENCE_LENGTH = 128;

/**
 * The persisted shape of a COD collection (§3.5 F-COD-01, §5.1, §8's `cod_collections`).
 *
 * `orderId` and `fulfillmentId` are scalar copies of Module 06 identifiers (ADR-002) — never a
 * relation across the context boundary. `driverId` is a `driver_profiles.id`, this module's own
 * operational driver, not a Module 01 user id.
 *
 * Both amounts are ETB minor-unit integers (ADR-005).
 */
export interface CodCollectionProps {
  id: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** `driver_profiles.id` of the driver who took the money. */
  driverId: string;
  /** What the job said was due — copied from `delivery_jobs.codAmount`, never client-supplied. */
  expectedAmount: number;
  /** What the driver declared they received. The only figure on the row that came from a request. */
  collectedAmount: number;
  currency: string;
  method: CodCollectionMethod;
  status: CodCollectionStatus;
  /** An opaque transaction reference for an electronic collection. `null` for cash. */
  providerReference: string | null;
  /** When the driver says the money changed hands. */
  collectedAt: Date;
  /** When the platform recorded it. */
  recordedAt: Date;
  remittedAt: Date | null;
  reconciledAt: Date | null;
  settlementRef: string | null;
}

/** What `CodCollection.record` needs. `status` is not an input — see the class comment. */
export interface NewCodCollectionInput {
  id: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  driverId: string;
  expectedAmount: number;
  collectedAmount: number;
  currency: string;
  method: CodCollectionMethod;
  providerReference?: string | null;
  collectedAt?: Date | null;
  now?: Date;
}

/**
 * `CodCollection` (§3.5 F-COD-01, §5.1) — what a driver collected from a customer at the door.
 *
 * ## Whose money this is, and why that shapes the type
 *
 * The approved flow is **customer → driver → PharmaLink → pharmacy**. The driver physically
 * receives the cash and is a *collection channel*, never its owner. So this aggregate records a
 * remittance obligation running from the driver to the platform — and deliberately carries no
 * driver balance, no link to `driver_earnings`, and no notion of the pharmacy being paid. What a
 * driver is *owed* (Work 10) and what a driver is *holding* are two unrelated amounts, and a type
 * that could net one against the other would eventually net one against the other.
 *
 * ## A declaration, not a verified payment
 *
 * `collectedAmount` is what the driver **says** they received. For cash nothing can verify it until
 * somebody counts the money; for an electronic collection nothing here talks to a provider. The
 * aggregate is therefore always created at `COLLECTED`, and the word means exactly "the delivery
 * channel recorded receiving payment" — not that PharmaLink has the money, and emphatically not
 * that the pharmacy has been paid.
 *
 * ## Immutable, structurally
 *
 * **There is no mutator on this class — not one.** No `markRemitted`, no `reconcile`, no amount
 * setter. `ICodCollectionRepository` offers no `update` and no `delete`, and the only route with a
 * write verb records a new collection. A driver's declaration about how much cash changed hands is
 * evidence in any later dispute, and evidence that can be edited is not evidence.
 *
 * That includes the transitions to `REMITTED` and `RECONCILED`. The values exist in the enum
 * because the lifecycle needs naming; nothing in this work sets them, because doing so requires a
 * remittance cadence and a verification authority the design's Open Question 5 leaves undecided,
 * and because a driver must never be able to declare their own cash reconciled.
 *
 * A correction is a new auditable adjustment under its own workflow. That work adds what it needs;
 * until then the absence here is the guarantee, exactly as it is for proof of delivery and for
 * driver earnings.
 */
export class CodCollection {
  private constructor(private readonly props: CodCollectionProps) {}

  /**
   * A newly recorded collection, always `COLLECTED`.
   *
   * `status` is not an input. A collection that could be constructed directly at `RECONCILED`
   * would make the whole boundary above advisory — and the caller able to do it would be a driver.
   */
  static record(input: NewCodCollectionInput): CodCollection {
    const now = input.now ?? new Date();
    const props: CodCollectionProps = {
      id: requireText(input.id, 'id'),
      jobId: requireText(input.jobId, 'jobId'),
      orderId: requireText(input.orderId, 'orderId'),
      fulfillmentId: requireText(input.fulfillmentId, 'fulfillmentId'),
      driverId: requireText(input.driverId, 'driverId'),
      expectedAmount: input.expectedAmount,
      collectedAmount: input.collectedAmount,
      currency: requireText(input.currency, 'currency'),
      method: input.method,
      status: CodCollectionStatus.COLLECTED,
      providerReference: normalizeReference(input.providerReference),
      collectedAt: input.collectedAt ?? now,
      recordedAt: now,
      remittedAt: null,
      reconciledAt: null,
      settlementRef: null,
    };
    assertConsistent(props);
    return new CodCollection(props);
  }

  /** Rebuilds from persistence. Re-checks invariants: a row that violates them is a defect. */
  static rehydrate(props: CodCollectionProps): CodCollection {
    assertConsistent(props);
    return new CodCollection({ ...props });
  }

  /**
   * The signed difference between what was collected and what was due.
   *
   * Positive means the customer paid more than the order came to, negative means less. Derived
   * rather than stored, because a stored copy of `collectedAmount - expectedAmount` is a third
   * number that can disagree with the two it came from.
   */
  get variance(): number {
    return this.props.collectedAmount - this.props.expectedAmount;
  }

  /** Whether the collected amount differs from what the job said was due. */
  get hasDiscrepancy(): boolean {
    return this.variance !== 0;
  }

  toProps(): CodCollectionProps {
    return { ...this.props };
  }
}

/** The signed difference for a persisted row, without rehydrating the aggregate. */
export function varianceOf(props: CodCollectionProps): number {
  return props.collectedAmount - props.expectedAmount;
}

/** Whether a persisted row's collected amount differs from what was due. */
export function hasDiscrepancy(props: CodCollectionProps): boolean {
  return varianceOf(props) !== 0;
}

/**
 * The invariants a collection row must satisfy, checked on the way in and on the way out.
 *
 * A **zero collected amount is legitimate** and is not treated as "nothing happened": a driver who
 * records that the customer handed over nothing is making a real, useful statement, and refusing it
 * would push them towards recording a figure that is not true. What is rejected is a negative
 * amount, which would be the customer taking money out of the delivery, and a negative expected
 * amount, which no order can produce.
 */
function assertConsistent(props: CodCollectionProps): void {
  for (const [field, value] of [
    ['expectedAmount', props.expectedAmount],
    ['collectedAmount', props.collectedAmount],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw DeliveryErrors.validation(
        `${field} must be a non-negative integer (minor units).`,
        { field, value },
      );
    }
  }

  if (
    props.providerReference !== null &&
    props.providerReference.length > MAX_PROVIDER_REFERENCE_LENGTH
  ) {
    throw DeliveryErrors.validation(
      `providerReference must be at most ${MAX_PROVIDER_REFERENCE_LENGTH} characters.`,
      { field: 'providerReference' },
    );
  }

  // Cash has no provider and therefore no reference to quote. A reference on a cash row would be
  // a number nobody could reconcile against anything, and the honest place to refuse it is here.
  if (props.method === CodCollectionMethod.CASH && props.providerReference !== null) {
    throw DeliveryErrors.validation('A cash collection cannot carry a provider reference.', {
      field: 'providerReference',
      method: props.method,
    });
  }
}

function normalizeReference(value?: string | null): string | null {
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
