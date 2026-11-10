// Work 120: the active job's next step (module-08 §9.2 status routes), and what the driver sees.
// The backend's status policy is the authority; this only offers the one step that comes next.

const STEPS = {
  ASSIGNED: { action: 'arrived-pickup', label: 'I am at the pharmacy', next: 'ARRIVED_PICKUP' },
  ARRIVED_PICKUP: { action: 'picked-up', label: 'I have picked up the order', next: 'PICKED_UP' },
  PICKED_UP: { action: 'en-route', label: 'I am on my way', next: 'EN_ROUTE' },
  EN_ROUTE: { action: 'arrived-dropoff', label: 'I have arrived at the customer', next: 'ARRIVED_DROPOFF' },
}

/** The next status step, or null when the next thing is proof of delivery (or nothing). */
export function nextStep(status) {
  return STEPS[status] ?? null
}

/** Where the driver is heading now: the pharmacy until pickup, then the customer. */
export function destination(job) {
  if (!job) return null
  const toPharmacy = job.status === 'ASSIGNED' || job.status === 'ARRIVED_PICKUP'
  return toPharmacy
    ? { kind: 'pickup', label: 'Pharmacy', address: job.pickupAddress }
    : { kind: 'dropoff', label: 'Customer', address: job.dropoffAddress }
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

export function stepErrorMessage(error) {
  if (error?.status === 0) return 'No connection to PharmaLink. Nothing was recorded; try again.'
  if (error?.code === 'INVALID_STATE_TRANSITION' || error?.status === 409) return 'This job changed meanwhile. It has been refreshed.'
  if (error?.code === 'POD_REQUIRED') return error.message || 'Proof of delivery is needed first.'
  return error?.message || 'That did not work. Try again.'
}
