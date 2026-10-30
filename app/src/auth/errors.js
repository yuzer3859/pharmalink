import { t } from './strings'

const isRecord = (value) => typeof value === 'object' && value !== null

/** Seconds until a retry is allowed, from the backend's error details; null when it gave none. */
export function retryAfterSeconds(error) {
  const seconds = isRecord(error?.details) ? Number(error.details.retryAfterSeconds) : NaN
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
}

/** A display message for an ApiError (or anything thrown). Never includes tokens or codes. */
export function describeAuthError(error) {
  const details = isRecord(error?.details) ? error.details : {}
  const retry = retryAfterSeconds(error)
  const withRetry = (message) => (retry ? `${message} ${t('error.retryIn', { seconds: retry })}` : message)

  switch (error?.code) {
    case 'NETWORK_ERROR':
      return t('error.network')
    case 'MALFORMED_RESPONSE':
    case 'HTTP_ERROR':
      return t('error.malformed')
    case 'RATE_LIMITED':
      return retry ? t('error.retryIn', { seconds: retry }) : t('error.rateLimited')
    case 'AUTH_DUPLICATE_IDENTIFIER':
      return t('error.duplicate')
    case 'AUTH_WEAK_PASSWORD':
      return t('error.weakPassword')
    case 'AUTH_INVALID_CREDENTIALS':
      return t('error.invalidCredentials')
    case 'AUTH_ACCOUNT_SUSPENDED':
      return t('error.suspended')
    case 'AUTH_ACCOUNT_LOCKED':
      return t('error.locked')
    case 'AUTH_OTP_INVALID':
      return t('error.otpInvalid')
    case 'AUTH_OTP_EXPIRED':
      return t('error.otpExpired')
    case 'AUTH_OTP_ATTEMPTS_EXCEEDED':
      return t('error.otpAttempts')
    case 'SESSION_EXPIRED':
    case 'AUTH_REFRESH_INVALID':
    case 'AUTH_REFRESH_REUSE_DETECTED':
      return t('error.sessionExpired')
    case 'NOT_CUSTOMER':
      return t('error.notCustomer')
    case 'DEPENDENCY_UNAVAILABLE':
      if (details.channel === 'SMS') return t('error.smsUnavailable')
      if (details.channel === 'EMAIL') {
        return withRetry(details.reason === 'NOT_CONFIGURED' ? t('error.emailNotConfigured') : t('error.emailFailed'))
      }
      return withRetry(t('error.unavailable'))
    case 'VALIDATION_ERROR':
      if (details.reason === 'SMS_UNAVAILABLE') return t('error.smsUnavailable')
      return error.message || t('error.generic')
    default:
      return t('error.generic')
  }
}

/** The unmet password rules the backend listed (AUTH_WEAK_PASSWORD details), if any. */
export function passwordRequirements(error) {
  const list = isRecord(error?.details) ? error.details.requirements : null
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []
}
