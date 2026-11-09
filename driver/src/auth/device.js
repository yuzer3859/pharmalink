// The backend registers a device per session (`deviceInfo`: fingerprint + DevicePlatform). The
// driver app is a browser, so DevicePlatform.WEB. The fingerprint is a random, non-secret
// per-browser id, so repeated sign-ins reuse one device row.

const DEVICE_KEY = 'pharmalink.driver.device'

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
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
  return { fingerprint, platform: 'WEB', name: 'PharmaLink driver app' }
}
