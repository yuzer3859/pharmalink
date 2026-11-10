// Work 123: the driver's earnings (`GET /driver/earnings`) and the cash they collected on COD jobs
// (`GET /delivery/jobs/:id/cod-collection`). Read-only: remittance is recorded by PharmaLink finance
// when the cash reaches them (the owner's COD decision), never on the driver's word.

export const EARNING_STATUS_TEXT = {
  ACCRUED: 'Earned, to be paid',
  SETTLED: 'Paid',
}

export const CASH_STATUS_TEXT = {
  COLLECTED: 'With you: hand it to PharmaLink',
  REMITTED: 'Handed to PharmaLink',
  RECONCILED: 'Handed to PharmaLink and checked',
}

/** Totals of the collections, in santim: cash still with the driver, and cash handed over. */
export function cashTotals(collections) {
  let withYou = 0
  let handedOver = 0
  for (const c of collections ?? []) {
    if (!c) continue
    if (c.status === 'COLLECTED') withYou += c.collectedAmount ?? 0
    else if (c.status === 'REMITTED' || c.status === 'RECONCILED') handedOver += c.collectedAmount ?? 0
  }
  return { withYou, handedOver }
}

/** Totals of the earnings, in santim: earned but not yet paid, and paid. */
export function earningTotals(items) {
  let toBePaid = 0
  let paid = 0
  for (const e of items ?? []) {
    if (e.status === 'SETTLED') paid += e.total ?? 0
    else toBePaid += e.total ?? 0
  }
  return { toBePaid, paid }
}

export function createMoneyService(request) {
  return {
    earnings: () => request('GET', '/driver/earnings?limit=50&offset=0'),
    deliveredJobs: () => request('GET', '/driver/jobs?status=DELIVERED&page=1&size=50'),
    cashCollection: (jobId) => request('GET', `/delivery/jobs/${encodeURIComponent(jobId)}/cod-collection`),
  }
}
