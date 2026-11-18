// Work 120: the active job's next step (module-08 §9.2 status routes), and what the driver sees.
// The backend's status policy is the authority; this only offers the one step that comes next.

const STEPS = {
  ASSIGNED: { action: 'arrived-pickup', label: 'I am at the pharmacy', next: 'ARRIVED_PICKUP' },
  ARRIVED_PICKUP: { action: 'picked-up', label: 'I have picked up the order', next: 'PICKED_UP' },
  PICKED_UP: { action: 'en-route', label: 'I am on my way', next: 'EN_ROUTE' },
  EN_ROUTE: { action: 'arrived-dropoff', label: 'I have arrived at the customer', next: 'ARRIVED_DROPOFF' },
}

/**
 * Work 139: a job carrying the original paper prescription (Work 136) starts at the customer — the
 * driver collects the paper, takes it to the pharmacist, and picks the medicine up once it is ready.
 */
export function collectsPaperFirst(job) {
  return !!job?.paper && !job.paper.collectedAt && job.status === 'ASSIGNED'
}

/** At the pharmacy with the paper, while the pharmacist checks it and prepares the medicine. */
export function waitsForPharmacist(job) {
  return !!job?.paper && job.status === 'ARRIVED_PICKUP' && !job.paper.goodsReady
}

const COLLECT_PAPER = { action: 'paper-collected', label: 'I have the paper prescription', next: 'ASSIGNED' }

/** The next status step, or null when the next thing is proof of delivery (or nothing, or waiting). */
export function nextStep(status, job) {
  if (job && collectsPaperFirst(job)) return COLLECT_PAPER
  if (job && waitsForPharmacist(job)) return null
  return STEPS[status] ?? null
}

/** The heading: the status, or the paper's own first leg. */
export function headline(job) {
  if (collectsPaperFirst(job)) return 'Collect the paper prescription from the customer'
  if (waitsForPharmacist(job)) return 'At the pharmacy: the pharmacist is checking the paper'
  return STATUS_TEXT[job?.status] ?? job?.status
}

/** Where the driver is heading now: the pharmacy until pickup, then the customer. */
export function destination(job) {
  if (!job) return null
  // Work 141: `point` is the place on the map ({ lat, lng }), or null when the job has none.
  if (collectsPaperFirst(job)) return { kind: 'dropoff', label: 'Customer: collect the paper prescription', address: job.dropoffAddress, point: validPoint(job.dropoff) }
  const toPharmacy = job.status === 'ASSIGNED' || job.status === 'ARRIVED_PICKUP'
  return toPharmacy
    ? { kind: 'pickup', label: 'Pharmacy', address: job.pickupAddress, point: validPoint(job.pickup) }
    : { kind: 'dropoff', label: 'Customer', address: job.dropoffAddress, point: validPoint(job.dropoff) }
}

/** A usable map point, or null. */
export function validPoint(p) {
  if (!p) return null
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 ? { lat: p.lat, lng: p.lng } : null
}

/** A delivery can be reported failed only once the driver holds the goods (the backend's rule). */
export function canFail(status) {
  return status === 'PICKED_UP' || status === 'EN_ROUTE' || status === 'ARRIVED_DROPOFF'
}

/** The customer sees the driver live from pickup until delivery. */
export function sharesLiveLocation(status) {
  return ['ASSIGNED', 'ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_DROPOFF'].includes(status)
}

export const STATUS_TEXT = {
  ASSIGNED: 'Go to the pharmacy',
  ARRIVED_PICKUP: 'At the pharmacy',
  PICKED_UP: 'Order picked up',
  EN_ROUTE: 'On the way to the customer',
  ARRIVED_DROPOFF: 'At the customer: record proof of delivery',
  DELIVERED: 'Delivered',
  FAILED: 'Delivery failed',
  CANCELLED: 'Cancelled',
}

/** A maps search link for an address (opens the phone's maps app); null when there is none. */
export function mapsLink(address) {
  return address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null
}

/**
 * Work 141: turn-by-turn directions in Google Maps to where the driver is heading: to the exact point
 * when the job has one, else a search for the address; null when there is neither.
 */
export function directionsLink(to) {
  if (!to) return null
  if (to.point) return `https://www.google.com/maps/dir/?api=1&destination=${to.point.lat},${to.point.lng}&travelmode=driving`
  return mapsLink(to.address)
}

export function stepErrorMessage(error) {
  if (error?.status === 0) return 'No connection to PharmaLink. Nothing was recorded; try again.'
  if (error?.code === 'INVALID_STATE_TRANSITION' || error?.status === 409) return 'This job changed meanwhile. It has been refreshed.'
  if (error?.code === 'POD_REQUIRED') return error.message || 'Proof of delivery is needed first.'
  return error?.message || 'That did not work. Try again.'
}
