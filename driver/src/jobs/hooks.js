import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { createDriverService, LOCATION_REPORT_MS, OFFER_POLL_MS } from './driverService'

export function useDriverService() {
  const { request } = useAuth()
  return useMemo(() => createDriverService(request), [request])
}

/**
 * The driver's jobs and live offers, polled every `OFFER_POLL_MS` while `enabled` (online, or
 * carrying a job). The first read is immediate; a failed poll keeps the last good answer.
 */
export function useDriverJobs(enabled) {
  const service = useDriverService()
  const [state, setState] = useState({ data: null, error: null })
  const load = useCallback(async () => {
    try {
      const data = await service.jobs()
      setState({ data, error: null })
    } catch (error) {
      setState((s) => ({ data: s.data, error }))
    }
  }, [service])

  useEffect(() => {
    if (!enabled) return undefined
    load()
    const id = setInterval(load, OFFER_POLL_MS)
    return () => clearInterval(id)
  }, [enabled, load])

  return { ...state, reload: load }
}

/** A clock that ticks every second while `active`, for offer countdowns. */
export function useNow(active) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function browserGeolocation() {
  return typeof navigator !== 'undefined' ? navigator.geolocation : undefined
}

/**
 * Work 119: while `enabled`, follows the device's position and reports it to dispatch at most every
 * `LOCATION_REPORT_MS`. Nothing is stored on the device; samples taken without a connection are
 * dropped, never replayed. Returns the permission state for the screen.
 */
export function useLocationReporter(enabled, { geolocation = browserGeolocation(), report } = {}) {
  const service = useDriverService()
  const send = report ?? service.reportLocation
  const lastSent = useRef(0)
  const [status, setStatus] = useState('idle')

  useEffect(() => {
    if (!enabled) {
      setStatus('idle')
      return undefined
    }
    if (!geolocation) {
      setStatus('unavailable')
      return undefined
    }
    setStatus('locating')
    const watchId = geolocation.watchPosition(
      (pos) => {
        setStatus('sharing')
        const now = Date.now()
        if (now - lastSent.current < LOCATION_REPORT_MS) return
        lastSent.current = now
        send(Number(pos.coords.latitude.toFixed(6)), Number(pos.coords.longitude.toFixed(6))).catch(() => {
          // A dropped report is not retried: the next sample replaces it.
          lastSent.current = 0
        })
      },
      () => setStatus('denied'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    )
    return () => geolocation.clearWatch(watchId)
  }, [enabled, geolocation, send])

  return status
}
