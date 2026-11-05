import { PayoutRail } from '@prisma/client';

export const PAYOUT_PROVIDER_PORT = Symbol('PAYOUT_PROVIDER_PORT');

/**
 * A payout rail (module-07 §15.5, ADR-022). Disbursement only: it addresses a settlement and a
 * pharmacy's verified beneficiary, never a customer or a payment, which is why it is not a method on
 * `IPaymentProviderPort`.
 */
export interface IPayoutProviderPort {
  /** Stable name, recorded on every attempt (`payout_attempts.providerKey`). */
  readonly key: string;

  /** Whether this rail may be used at all in this process. A rail that is not refuses before any write. */
  isAvailable(): boolean;

  /**
   * Sends the payout. Idempotent on `reference` (`PAYOUT-<attemptId>`): asking again for the same
   * reference answers `ALREADY_PAID` or the original outcome, never a second transfer.
   */
  pay(request: PayoutRequest): Promise<PayoutResult>;

  /** The resolution path for an attempt left PENDING or UNKNOWN (§15.5). */
  getStatus(reference: string): Promise<PayoutResult>;
}

export interface PayoutRequest {
  reference: string;
  settlementId: string;
  pharmacyId: string;
  /** Integer minor units (santim). */
  amount: number;
  currency: string;
  beneficiary: {
    rail: PayoutRail;
    accountName: string;
    bankCode: string | null;
    /** Decrypted only for this call; never logged or stored in clear. */
    accountIdentifier: string;
  };
}

/**
 * The module's five-valued outcome shape (§15.5). `UNKNOWN` must never be collapsed into `FAILED`:
 * doing so frees the statement to be paid again while the first transfer may have gone through.
 */
export enum PayoutOutcome {
  PAID = 'PAID',
  ALREADY_PAID = 'ALREADY_PAID',
  PENDING = 'PENDING',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
}

export interface PayoutResult {
  outcome: PayoutOutcome;
  providerReference?: string | null;
  /** Sanitized; set when `outcome` is FAILED. */
  failureReason?: string | null;
}
