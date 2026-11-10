// Work 119: the driver's availability, offers and location on the real API (module-08 §9.1–9.2,
// Work 117). Every call is the signed-in driver's own; nothing here names a driver.

/** Offers are polled while online: an offer lives 30 s by default, so 5 s leaves time to decide. */
export const OFFER_POLL_MS = 5_000
/** The dispatch location is reported at most this often (the server also ignores reports < 3 s apart). */
export const LOCATION_REPORT_MS = 15_000

/** Job statuses the driver is still working on, oldest step first. */
export const ACTIVE_STATUSES = ['ASSIGNED', 'ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_DROPOFF']

/** Whole seconds left on an offer, never below 0. */
export function secondsLeft(expiresAt, now = Date.now()) {
  const ms = Date.parse(expiresAt) - now
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0
}

/** Birr from santim, for display. */
export const birr = (santim) => `ETB ${(santim / 100).toFixed(2)}`

export function distanceLabel(meters) {
  if (meters == null) return null
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`
}

/** Live offers only (the server already drops expired ones; the clock may have moved since). */
export function liveOffers(offers, now = Date.now()) {
  return (offers ?? []).filter((o) => secondsLeft(o.expiresAt, now) > 0)
}

export function activeJobs(items) {
  return (items ?? []).filter((j) => ACTIVE_STATUSES.includes(j.status))
}

/** Why going online failed, in words a driver can act on. */
export function availabilityErrorMessage(error) {
  if (error?.status === 0) return 'No connection to PharmaLink. Check your data and try again.'
  if (error?.code === 'DRIVER_NOT_VERIFIED' || error?.status === 403) return 'You are not verified to drive yet, so you cannot go online.'
  if (error?.status === 409) return error.message || 'You cannot change that right now.'
  return error?.message || 'That did not work. Try again.'
}

export function offerErrorMessage(error) {
  if (error?.code === 'OFFER_EXPIRED') return 'That offer has expired.'
  if (error?.code === 'CONCURRENT_LIMIT_REACHED') return 'You already carry as many jobs as you can.'
  if (error?.code === 'JOB_ALREADY_ASSIGNED') return 'Another driver took that job.'
  if (error?.status === 0) return 'No connection to PharmaLink.'
  return error?.message || 'That did not work. Try again.'
}

export function createDriverService(request) {
  const job = (id, action) => `/delivery/jobs/${encodeURIComponent(id)}/${action}`
  return {
    setAvailability: (status) => request('PUT', '/driver/availability', { status }),
    profile: () => request('GET', '/driver/profile'),
    jobs: () => request('GET', '/driver/jobs?page=1&size=20'),
    accept: (jobId) => request('POST', job(jobId, 'accept')),
    decline: (jobId, reason) => request('POST', job(jobId, 'decline'), reason?.trim() ? { reason: reason.trim() } : {}),
    reportLocation: (lat, lng) => request('POST', '/delivery/location', { lat, lng }),
  }
}
