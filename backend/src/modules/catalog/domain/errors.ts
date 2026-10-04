import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/**
 * Catalog domain/application errors (module-03 §13). Thrown from the domain and application
 * layers and translated to the standard error envelope by the global AllExceptionsFilter.
 */
export const CatalogErrors = {
  validation: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, message, details),

  notFound: (message = 'Resource not found', details?: unknown) =>
    new ApiException(ErrorCode.NOT_FOUND, message, details),

  invalidClassification: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.INVALID_CLASSIFICATION, message, details),

  duplicateProduct: (candidateId: string) =>
    new ApiException(ErrorCode.CATALOG_DUPLICATE_PRODUCT, 'A matching product already exists.', {
      productId: candidateId,
    }),

  invalidStatusTransition: (from: string, to: string) =>
    new ApiException(
      ErrorCode.INVALID_PRODUCT_STATUS_TRANSITION,
      `Cannot transition product status from ${from} to ${to}.`,
      { from, to },
    ),

  manufacturerNotFound: () =>
    new ApiException(ErrorCode.MANUFACTURER_NOT_FOUND, 'Manufacturer not found.'),

  categoryNotFound: () => new ApiException(ErrorCode.CATEGORY_NOT_FOUND, 'Category not found.'),

  categoryCycleDetected: () =>
    new ApiException(
      ErrorCode.CATEGORY_CYCLE_DETECTED,
      'This parent category would create a cycle in the category tree.',
    ),

  categoryHasProducts: () =>
    new ApiException(
      ErrorCode.CATEGORY_HAS_PRODUCTS,
      'This category still has active products assigned to it.',
    ),

  /**
   * A mutation's transaction (state change + audit + outbox, ADR-010, mirroring
   * DEFECT-PROFILES-002's fix) contended for longer than the bounded retry budget — e.g. the
   * medicine dedup partial unique index (§6.2) or a Serializable write-conflict from the audit
   * hash chain. Returned instead of a 500 so the client can simply retry.
   */
  concurrentModification: (details?: unknown) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This record was changed concurrently by another request. Please retry.',
      details,
    ),
};
