import { describe, expect, it, vi } from 'vitest'
import { cashTotals, createMoneyService, earningTotals } from './money'

describe('cash totals (Work 123)', () => {
  it('counts collected cash as still with the driver, and remitted or reconciled cash as handed over', () => {
    expect(
      cashTotals([
        { status: 'COLLECTED', collectedAmount: 5700 },
        { status: 'COLLECTED', collectedAmount: 1200 },
        { status: 'REMITTED', collectedAmount: 4500 },
        { status: 'RECONCILED', collectedAmount: 300 },
        null,
      ]),
    ).toEqual({ withYou: 6900, handedOver: 4800 })
    expect(cashTotals(undefined)).toEqual({ withYou: 0, handedOver: 0 })
  })
})

describe('earning totals', () => {
  it('splits what is still to be paid from what was paid', () => {
    expect(earningTotals([{ status: 'ACCRUED', total: 3000 }, { status: 'SETTLED', total: 2500 }, { status: 'ACCRUED', total: 1000 }])).toEqual({ toBePaid: 4000, paid: 2500 })
  })
})

describe('money service', () => {
  it('reads earnings, delivered jobs and one job’s collection', async () => {
    const request = vi.fn().mockResolvedValue({})
    const s = createMoneyService(request)
    await s.earnings()
    expect(request).toHaveBeenLastCalledWith('GET', '/driver/earnings?limit=50&offset=0')
    await s.deliveredJobs()
    expect(request).toHaveBeenLastCalledWith('GET', '/driver/jobs?status=DELIVERED&page=1&size=50')
    await s.cashCollection('job/1')
    expect(request).toHaveBeenLastCalledWith('GET', '/delivery/jobs/job%2F1/cod-collection')
  })

  it('is read-only: a driver never records a remittance', () => {
    expect(Object.keys(createMoneyService(vi.fn())).sort()).toEqual(['cashCollection', 'deliveredJobs', 'earnings'])
  })
})
