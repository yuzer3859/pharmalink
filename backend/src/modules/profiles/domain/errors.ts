import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/**
 * Profiles domain/application errors (module-02 §13). Thrown from the domain and application
 * layers and translated to the standard error envelope by the global AllExceptionsFilter.
 * Ownership-mismatch reads/writes must use `notFound`, never `forbidden` — see §7.3/§12
 * ("no existence leakage").
 */
export const ProfileErrors = {
  validation: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, message, details),

  notFound: (message = 'Resource not found', details?: unknown) =>
    new ApiException(ErrorCode.NOT_FOUND, message, details),

  outsideEthiopia: () =>
    new ApiException(
      ErrorCode.ADDRESS_OUTSIDE_ETHIOPIA,
      'This address is outside the supported delivery area (Ethiopia).',
    ),

  addressLimitReached: () =>
    new ApiException(
      ErrorCode.ADDRESS_LIMIT_REACHED,
      'You have reached the maximum number of saved addresses.',
    ),

  defaultAddressRequired: () =>
    new ApiException(
      ErrorCode.DEFAULT_ADDRESS_REQUIRED,
      'Set another address as default before removing this one, or delete it instead.',
    ),

  /**
   * A mutation's transaction (state change + audit + outbox, DEFECT-PROFILES-002/ADR-010)
   * contended for longer than the bounded retry budget — e.g. the default-address partial
   * unique index (DEFECT-PROFILES-001, §6.3/edge case 8) or a Serializable write-conflict from
   * the audit hash chain. Returned instead of a 500 so the client can simply retry; no database
   * invariant is ever violated in the meantime.
   */
  concurrentModification: (details?: unknown) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This record was changed concurrently by another request. Please retry.',
      details,
    ),
};
