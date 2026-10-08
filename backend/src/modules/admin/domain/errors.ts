import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/**
 * Module 16's error factories (module-16 §9's representative errors, §12).
 *
 * The catalogue is append-only and a code is added when its thrower exists, never speculatively —
 * the convention every module before this one follows. This work therefore adds **one** code,
 * `CONFIG_VALIDATION_FAILED`, which the design names outright and which nothing else in the
 * repository can express: a well-formed request from an entitled caller carrying a value the owning
 * module's own contract refuses is neither a generic validation error nor a conflict.
 *
 * The rest reuse shared codes, because they are the shared meanings:
 *
 *  - **`configKeyNotGovernable` → `NOT_FOUND`.** A key outside the catalogue does not exist as far
 *    as this API is concerned, and answering `FORBIDDEN` would confirm that a key like
 *    `TELEBIRR_API_SECRET` is a real setting somewhere — the same no-existence-leakage discipline
 *    every other module applies to scoping.
 *  - **`configVersionNotFound` → `NOT_FOUND`.** A rollback target that was never published.
 *  - **`concurrentConfigChange` → `CONFLICT`.** Two administrators published the same key at once
 *    and this one lost the version race. The request was valid; it simply needs re-reading.
 *
 * `ADMIN_PERMISSION_DENIED` and `ELEVATED_ROLE_REQUIRED` from §9 are **not** added: authorization
 * is already enforced by `PermissionsGuard`, which answers with the existing `RBAC_FORBIDDEN`, and
 * adding a second code for the same refusal would give one rejection two names.
 */
export const AdminErrors = {
  validation: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, message, details),

  /** No notification suppression with that id — unknown, or already removed (module-13 Work 19). */
  suppressionNotFound: () => new ApiException(ErrorCode.NOT_FOUND, 'Suppression not found.'),

  /**
   * The key is not in `ConfigCatalogue` — it is not a setting an administrator may govern.
   *
   * This is the security refusal §18 depends on, and it is deliberately indistinguishable from
   * "no such key": the answer to "may I set the Telebirr API secret through this API?" should
   * carry no information beyond "no".
   */
  configKeyNotGovernable: (namespace: string, key: string) =>
    new ApiException(ErrorCode.NOT_FOUND, 'Configuration key not found.', { namespace, key }),

  /** The supplied value does not satisfy the owning module's declared contract. */
  configValidationFailed: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.CONFIG_VALIDATION_FAILED, message, details),

  /** A rollback named a version that does not exist for this key. */
  configVersionNotFound: (namespace: string, key: string, version: number) =>
    new ApiException(ErrorCode.NOT_FOUND, 'Configuration version not found.', {
      namespace,
      key,
      version,
    }),

  /**
   * Somebody else published a new version of this key between the read and the write.
   *
   * Reported rather than retried silently: the losing administrator's intended value was computed
   * against a version that is no longer current, and re-applying it blindly would overwrite a
   * decision they never saw.
   */
  concurrentConfigChange: (namespace: string, key: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'Configuration was changed concurrently. Re-read and try again.',
      { namespace, key },
    ),

  /** A feature flag key that is not a well-formed flag name. */
  featureFlagInvalid: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, message, details),
} as const;
