// Public build-time settings only. Never put backend secrets (Resend, JWT, OTP) in VITE_ variables:
// everything here ships to the browser.

export function resolveApiBaseUrl(raw) {
  const configured = typeof raw === 'string' ? raw.trim() : ''
  return (configured || 'http://localhost:3000').replace(/\/+$/, '')
}

export const API_BASE_URL = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL)
