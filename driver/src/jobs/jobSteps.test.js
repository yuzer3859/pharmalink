import { describe, expect, it, vi } from 'vitest'
import { canFail, destination, mapsLink, nextStep, sharesLiveLocation, stepErrorMessage } from './jobSteps'
import { connectDriverTracking } from './trackingSocket'
import { createDriverService } from './driverService'

describe('the active job’s next step (Work 120)', () => {
  it('offers exactly the next status step, and none once proof of delivery is next', () => {
    expect(nextStep('ASSIGNED')).toMatchObject({ action: 'arrived-pickup', next: 'ARRIVED_PICKUP' })
    expect(nextStep('ARRIVED_PICKUP')).toMatchObject({ action: 'picked-up' })
    expect(nextStep('PICKED_UP')).toMatchObject({ action: 'en-route' })
    expect(nextStep('EN_ROUTE')).toMatchObject({ action: 'arrived-dropoff' })
    for (const status of ['ARRIVED_DROPOFF', 'DELIVERED', 'FAILED', 'OFFERED']) expect(nextStep(status)).toBeNull()
  })

  it('heads to the pharmacy until pickup, then to the customer', () => {
    const job = { pickupAddress: 'Bole Main', dropoffAddress: 'Bole Road 12' }
    expect(destination({ ...job, status: 'ASSIGNED' })).toMatchObject({ kind: 'pickup', address: 'Bole Main' })
    expect(destination({ ...job, status: 'ARRIVED_PICKUP' })).toMatchObject({ kind: 'pickup' })
    expect(destination({ ...job, status: 'PICKED_UP' })).toMatchObject({ kind: 'dropoff', address: 'Bole Road 12' })
    expect(destination(null)).toBeNull()
  })

  it('allows reporting a failure only once the goods are in hand (the backend’s rule)', () => {
    expect(canFail('ASSIGNED')).toBe(false)
    expect(canFail('ARRIVED_PICKUP')).toBe(false)
    expect(canFail('PICKED_UP')).toBe(true)
    expect(canFail('ARRIVED_DROPOFF')).toBe(true)
    expect(canFail('DELIVERED')).toBe(false)
  })

  it('shares the live location from assignment until the job closes', () => {
    expect(sharesLiveLocation('ASSIGNED')).toBe(true)
    expect(sharesLiveLocation('EN_ROUTE')).toBe(true)
    expect(sharesLiveLocation('DELIVERED')).toBe(false)
  })

  it('links an address to maps, and words step errors plainly', () => {
    expect(mapsLink('Bole Road 12')).toBe('https://www.google.com/maps/search/?api=1&query=Bole%20Road%2012')
    expect(mapsLink(null)).toBeNull()
    expect(stepErrorMessage({ status: 0 })).toMatch(/Nothing was recorded/)
    expect(stepErrorMessage({ status: 409, code: 'INVALID_STATE_TRANSITION' })).toMatch(/changed meanwhile/)
  })
})

describe('status posts', () => {
  it('carry the last fix when there is one, and the fail reason trimmed', async () => {
    const request = vi.fn().mockResolvedValue({})
    const s = createDriverService(request)
    await s.advance('job-1', 'picked-up', { lat: 9.01, lng: 38.76 })
    expect(request).toHaveBeenLastCalledWith('POST', '/delivery/jobs/job-1/picked-up', { lat: 9.01, lng: 38.76 })
    await s.advance('job-1', 'en-route', null)
    expect(request).toHaveBeenLastCalledWith('POST', '/delivery/jobs/job-1/en-route', {})
    await s.fail('job-1', ' Customer not reachable ', null)
    expect(request).toHaveBeenLastCalledWith('POST', '/delivery/jobs/job-1/fail', { reason: 'Customer not reachable' })
    await s.status('job-1')
    expect(request).toHaveBeenLastCalledWith('GET', '/delivery/jobs/job-1/status')
  })
})

describe('driver tracking socket', () => {
  function fakeSocket() {
    const handlers = {}
    const socket = {
      connected: true,
      on: vi.fn((event, fn) => { handlers[event] = fn }),
      emit: vi.fn(),
      disconnect: vi.fn(),
    }
    return { socket, handlers, connect: vi.fn(() => socket) }
  }

  it('connects to /tracking with the token in the handshake and publishes the job’s position', () => {
    const { socket, connect } = fakeSocket()
    const tracking = connectDriverTracking({ token: 'access-1', connect, baseUrl: 'http://api.test' })
    expect(connect).toHaveBeenCalledWith('http://api.test/tracking', expect.objectContaining({ auth: { token: 'access-1' } }))

    expect(tracking.publish('job-1', 9.01, 38.76)).toBe(true)
    const [event, payload] = socket.emit.mock.calls[0]
    expect(event).toBe('tracking:location')
    expect(payload).toMatchObject({ jobId: 'job-1', lat: 9.01, lng: 38.76 })
    expect(typeof payload.recordedAt).toBe('string')

    tracking.close()
    expect(socket.disconnect).toHaveBeenCalled()
  })

  it('drops a position while disconnected instead of queueing it, and reports refusals', () => {
    const { socket, connect } = fakeSocket()
    const onError = vi.fn()
    const tracking = connectDriverTracking({ token: 't', connect, baseUrl: 'http://api.test', onError })
    socket.connected = false
    expect(tracking.publish('job-1', 1, 2)).toBe(false)
    expect(socket.emit).not.toHaveBeenCalled()

    socket.connected = true
    tracking.publish('job-1', 1, 2)
    socket.emit.mock.calls[0][2]({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(onError).toHaveBeenCalledWith({ code: 'FORBIDDEN' })
  })
})
