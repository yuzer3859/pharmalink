// The backend registers a device per session (`deviceInfo`: fingerprint + DevicePlatform). Browsers
// use DevicePlatform.WEB. The fingerprint is a random, non-secret per-browser id, so repeated sign-ins
// reuse one device row instead of creating a new one each time.

const DEVICE_KEY = 'pharmalink.customer.device'

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function getDeviceInfo(storage = safeLocalStorage()) {
  let fingerprint = null
  try {
    fingerprint = storage?.getItem(DEVICE_KEY) ?? null
    if (!fingerprint) {
      fingerprint = randomId()
      storage?.setItem(DEVICE_KEY, fingerprint)
    }
  } catch {
    fingerprint = fingerprint || randomId()
  }
  return { fingerprint, platform: 'WEB', name: 'PharmaLink web' }
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
