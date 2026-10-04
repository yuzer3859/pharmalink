import { ERROR_HTTP_STATUS, ErrorCode } from './error-codes';

/**
 * Domain-level exception carrying a canonical ErrorCode. Feature modules throw subclasses of
 * this (or this directly) instead of raw HttpException, so the envelope + status mapping is
 * consistent everywhere. The global filter translates it to an ErrorEnvelope.
 */
export class ApiException extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiException';
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static notFound(message = 'Resource not found', details?: unknown): ApiException {
    return new ApiException(ErrorCode.NOT_FOUND, message, details);
  }

  static validation(message = 'Validation failed', details?: unknown): ApiException {
    return new ApiException(ErrorCode.VALIDATION_ERROR, message, details);
  }

  static forbidden(message = 'Forbidden', details?: unknown): ApiException {
    return new ApiException(ErrorCode.FORBIDDEN, message, details);
  }

  static unauthenticated(message = 'Authentication required', details?: unknown): ApiException {
    return new ApiException(ErrorCode.UNAUTHENTICATED, message, details);
  }

  static conflict(message = 'Conflict', details?: unknown): ApiException {
    return new ApiException(ErrorCode.CONFLICT, message, details);
  }

  static businessRule(message: string, details?: unknown): ApiException {
    return new ApiException(ErrorCode.BUSINESS_RULE_VIOLATION, message, details);
  }
}
