import { t } from './strings'

// Mirrors the backend's PasswordPolicy (8+ characters, upper, lower, digit). The backend still
// enforces it; this only saves a round trip and explains the rules up front.
export const PASSWORD_RULES = [
  { key: 'password.rule.length', test: (p) => p.length >= 8 },
  { key: 'password.rule.upper', test: (p) => /[A-Z]/.test(p) },
  { key: 'password.rule.lower', test: (p) => /[a-z]/.test(p) },
  { key: 'password.rule.digit', test: (p) => /\d/.test(p) },
]

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateEmail(value) {
  const email = value.trim()
  if (!email) return t('validation.email.required')
  if (!EMAIL_PATTERN.test(email) || email.length > 254) return t('validation.email.invalid')
  return null
}

export function validatePassword(value) {
  if (!value) return t('validation.password.required')
  if (value.length > 128) return t('validation.password.tooLong')
  const unmet = PASSWORD_RULES.filter((rule) => !rule.test(value))
  return unmet.length ? t('validation.password.weak') : null
}

export function validateConfirmation(password, confirmation) {
  if (!confirmation) return t('validation.confirm.required')
  return password === confirmation ? null : t('validation.confirm.mismatch')
}

export function validateOtp(value) {
  return /^\d{6}$/.test(value) ? null : t('validation.otp.format')
}

/** Keeps digits only, at most six: works for typing, autofill and pasting "123 456". */
export function normalizeOtp(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 6)
}
