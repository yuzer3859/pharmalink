// Lightweight className combiner (no extra deps).
export function cn(...args) {
  return args
    .flat(Infinity)
    .filter(Boolean)
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function formatETB(amount) {
  return new Intl.NumberFormat('en-ET', {
    style: 'currency',
    currency: 'ETB',
    maximumFractionDigits: 0,
  }).format(amount)
}

/**
 * Formats an integer amount in minor units (santim for ETB) without floating-point arithmetic:
 * 12345 ETB -> "ETB 123.45". The backend stores every price this way (00-shared-conventions §11).
 * Returns null for anything that isn't a safe integer, so a bad value is never shown as a price.
 */
export function formatMinorUnits(amount, currency = 'ETB') {
  if (!Number.isSafeInteger(amount) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null
  let digits = 2
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
  } catch {
    return null
  }
  const negative = amount < 0
  const units = BigInt(Math.abs(amount))
  const scale = 10n ** BigInt(digits)
  const major = new Intl.NumberFormat('en-US').format(units / scale)
  const minor = digits > 0 ? `.${(units % scale).toString().padStart(digits, '0')}` : ''
  return `${negative ? '-' : ''}${currency} ${major}${minor}`
}
