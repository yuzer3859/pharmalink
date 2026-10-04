import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/**
 * Identity domain/application errors. These are thrown from the domain and application layers
 * (framework-free apart from the shared ApiException carrier) and translated to the standard
 * error envelope by the global AllExceptionsFilter. Messages are display-safe and deliberately
 * generic where user-enumeration must be avoided (login / password reset).
 */
export const IdentityErrors = {
  duplicateIdentifier: (details?: unknown) =>
    new ApiException(
      ErrorCode.AUTH_DUPLICATE_IDENTIFIER,
      'An account with this phone or email already exists.',
      details,
    ),

  invalidCredentials: () =>
    new ApiException(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials.'),

  accountSuspended: () =>
    new ApiException(ErrorCode.AUTH_ACCOUNT_SUSPENDED, 'This account is suspended.'),

  accountLocked: () =>
    new ApiException(ErrorCode.AUTH_ACCOUNT_LOCKED, 'This account is temporarily locked.'),

  otpInvalid: () => new ApiException(ErrorCode.AUTH_OTP_INVALID, 'The code is invalid.'),

  otpExpired: () =>
    new ApiException(ErrorCode.AUTH_OTP_EXPIRED, 'The code has expired. Please request a new one.'),

  otpAttemptsExceeded: () =>
    new ApiException(
      ErrorCode.AUTH_OTP_ATTEMPTS_EXCEEDED,
      'Too many incorrect attempts. Please request a new code.',
    ),

  weakPassword: (details?: unknown) =>
    new ApiException(
      ErrorCode.AUTH_WEAK_PASSWORD,
      'Password does not meet the security requirements.',
      details,
    ),

  refreshInvalid: () =>
    new ApiException(ErrorCode.AUTH_REFRESH_INVALID, 'The session token is invalid or expired.'),

  refreshReuseDetected: () =>
    new ApiException(
      ErrorCode.AUTH_REFRESH_REUSE_DETECTED,
      'Session anomaly detected. Please sign in again.',
    ),

  tokenInvalid: () =>
    new ApiException(ErrorCode.AUTH_TOKEN_INVALID, 'The access token is invalid.'),

  /**
   * The holder's permissions changed after this token was minted. TOKEN_EXPIRED (not FORBIDDEN)
   * because the remedy is the one clients already implement for a 401: refresh and retry.
   */
  permissionsChanged: () =>
    new ApiException(
      ErrorCode.TOKEN_EXPIRED,
      'Your access has changed. Please refresh your session.',
    ),

  /** A verification request that is no longer PENDING cannot be re-decided (module-01 §9.4). */
  verificationClosed: (status: string) =>
    new ApiException(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      'This verification request has already been decided.',
      { status },
    ),

  /** Separation of duties: the subject of a verification may never review it (module-01 §9.4). */
  selfReview: () =>
    new ApiException(ErrorCode.FORBIDDEN, 'You cannot review your own verification request.'),

  verificationPending: () =>
    new ApiException(
      ErrorCode.VERIFICATION_PENDING,
      'A verification request of this type is already awaiting review.',
    ),

  invalidStatusTransition: (from: string, to: string) =>
    new ApiException(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      `An account with status ${from} cannot be moved to ${to}.`,
      { from, to },
    ),

  validation: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, message, details),
};
