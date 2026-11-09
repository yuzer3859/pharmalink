import { describe, expect, it, vi } from 'vitest'
import {
  activeJobs,
  availabilityErrorMessage,
  birr,
  createDriverService,
  distanceLabel,
  liveOffers,
  offerErrorMessage,
  secondsLeft,
} from './driverService'

const NOW = Date.parse('2026-11-10T10:00:00.000Z')

describe('offer time', () => {
  it('counts whole seconds down to the expiry, never below 0', () => {
    expect(secondsLeft('2026-11-10T10:00:30.000Z', NOW)).toBe(30)
    expect(secondsLeft('2026-11-10T10:00:00.400Z', NOW)).toBe(1)
    expect(secondsLeft('2026-11-10T09:59:59.000Z', NOW)).toBe(0)
    expect(secondsLeft('not a date', NOW)).toBe(0)
  })

  it('keeps only offers with time left', () => {
    const offers = [{ offerId: 'a', expiresAt: '2026-11-10T10:00:20.000Z' }, { offerId: 'b', expiresAt: '2026-11-10T09:59:00.000Z' }]
    expect(liveOffers(offers, NOW).map((o) => o.offerId)).toEqual(['a'])
    expect(liveOffers(undefined, NOW)).toEqual([])
  })
})

describe('display helpers', () => {
  it('shows money in birr and distance in m or km', () => {
    expect(birr(4550)).toBe('ETB 45.50')
    expect(distanceLabel(850)).toBe('850 m')
    expect(distanceLabel(1033)).toBe('1.0 km')
    expect(distanceLabel(null)).toBeNull()
  })

  it('keeps the jobs still being worked on', () => {
    const items = [{ jobId: '1', status: 'ASSIGNED' }, { jobId: '2', status: 'DELIVERED' }, { jobId: '3', status: 'EN_ROUTE' }, { jobId: '4', status: 'FAILED' }]
    expect(activeJobs(items).map((j) => j.jobId)).toEqual(['1', '3'])
  })
})

describe('error messages', () => {
  it('say what happened in words a driver can act on', () => {
    expect(availabilityErrorMessage({ status: 0 })).toMatch(/No connection/)
    expect(availabilityErrorMessage({ status: 403, code: 'DRIVER_NOT_VERIFIED' })).toMatch(/not verified/)
    expect(offerErrorMessage({ status: 409, code: 'OFFER_EXPIRED' })).toBe('That offer has expired.')
    expect(offerErrorMessage({ status: 409, code: 'JOB_ALREADY_ASSIGNED' })).toMatch(/Another driver/)
    expect(offerErrorMessage({ status: 409, code: 'CONCURRENT_LIMIT_REACHED' })).toMatch(/as many jobs/)
  })
})

describe('driver service', () => {
  it('calls the driver routes with their bodies', async () => {
    const request = vi.fn().mockResolvedValue({})
    const s = createDriverService(request)

    await s.setAvailability('ONLINE')
    expect(request).toHaveBeenLastCalledWith('PUT', '/driver/availability', { status: 'ONLINE' })
    await s.jobs()
    expect(request).toHaveBeenLastCalledWith('GET', '/driver/jobs?page=1&size=20')
    await s.accept('job/1')
    expect(request).toHaveBeenLastCalledWith('POST', '/delivery/jobs/job%2F1/accept')
    await s.decline('job-1', '  ')
    expect(request).toHaveBeenLastCalledWith('POST', '/delivery/jobs/job-1/decline', {})
    await s.decline('job-1', ' too far ')
    expect(request).toHaveBeenLastCalledWith('POST', '/delivery/jobs/job-1/decline', { reason: 'too far' })
    await s.reportLocation(9.01, 38.76)
    expect(request).toHaveBeenLastCalledWith('POST', '/delivery/location', { lat: 9.01, lng: 38.76 })
  })
})
