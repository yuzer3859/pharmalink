import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/**
 * Pharmacy & Inventory domain/application errors (module-04 §10.3). Thrown from the domain and
 * application layers and translated to the standard error envelope by the global
 * AllExceptionsFilter, mirroring `modules/catalog/domain/errors.ts`.
 */
export const PharmacyInventoryErrors = {
  validation: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, message, details),

  notFound: (message = 'Resource not found', details?: unknown) =>
    new ApiException(ErrorCode.NOT_FOUND, message, details),

  forbidden: (message = 'Forbidden', details?: unknown) =>
    new ApiException(ErrorCode.FORBIDDEN, message, details),

  pharmacyNotEligible: () =>
    new ApiException(
      ErrorCode.PHARMACY_NOT_ELIGIBLE,
      'This pharmacy is not currently eligible to transact.',
    ),

  licenseExpired: () =>
    new ApiException(ErrorCode.LICENSE_EXPIRED, 'This pharmacy license has expired.'),

  pharmacySuspended: () =>
    new ApiException(ErrorCode.PHARMACY_SUSPENDED, 'This pharmacy is suspended.'),

  pharmacyAlreadyRegistered: () =>
    new ApiException(
      ErrorCode.PHARMACY_ALREADY_REGISTERED,
      'A pharmacy is already registered for this organization.',
    ),

  branchNotFound: () => new ApiException(ErrorCode.BRANCH_NOT_FOUND, 'Branch not found.'),

  listingNotFound: () => new ApiException(ErrorCode.LISTING_NOT_FOUND, 'Listing not found.'),

  duplicateListing: (listingId: string) =>
    new ApiException(ErrorCode.DUPLICATE_LISTING, 'A listing for this product already exists at this branch.', {
      listingId,
    }),

  insufficientStock: (available: number) =>
    new ApiException(ErrorCode.INSUFFICIENT_STOCK, 'Insufficient sellable stock for this request.', {
      available,
    }),

  batchExpired: () => new ApiException(ErrorCode.BATCH_EXPIRED, 'This stock batch has expired.'),

  reservationNotFound: () =>
    new ApiException(ErrorCode.RESERVATION_NOT_FOUND, 'Reservation not found.'),

  invalidReservationState: (from: string, to: string) =>
    new ApiException(
      ErrorCode.INVALID_RESERVATION_STATE,
      `Cannot transition reservation from ${from} to ${to}.`,
      { from, to },
    ),

  reservationExpired: () =>
    new ApiException(ErrorCode.RESERVATION_EXPIRED, 'This reservation has expired.'),

  catalogProductNotFound: () =>
    new ApiException(ErrorCode.CATALOG_PRODUCT_NOT_FOUND, 'Catalog product not found or inactive.'),

  controlledProhibited: () =>
    new ApiException(
      ErrorCode.CONTROLLED_PROHIBITED,
      'This product is prohibited from online sale.',
    ),

  organizationNotFound: () =>
    new ApiException(ErrorCode.NOT_FOUND, 'Organization not found.'),

  /**
   * Same `idempotencyKey` reused (for the same listing) with a materially different payload
   * (different `orderId` and/or `quantity`) — module-04 §5.4/§8/§15. A genuine replay (identical
   * key + identical payload) instead returns the original reservation; this is only thrown when
   * the payload disagrees, so silently returning the mismatched reservation can never happen.
   */
  idempotencyKeyConflict: () =>
    new ApiException(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      'This idempotency key was already used for a different reservation request.',
    ),
};
