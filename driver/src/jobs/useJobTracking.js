import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { connectDriverTracking } from './trackingSocket'

/** Live positions are published at most this often while carrying a job. */
export const LIVE_PUBLISH_MS = 5_000

function browserGeolocation() {
  return typeof navigator !== 'undefined' ? navigator.geolocation : undefined
}

/**
 * Work 120: while `enabled`, follows the device's position, keeps the last fix for the status posts,
 * and publishes it for the job over the tracking socket every `LIVE_PUBLISH_MS`. Nothing is stored
 * on the device. Returns `{ status, lastFix }`.
 */
export function useJobTracking(jobId, enabled, { geolocation = browserGeolocation(), connect } = {}) {
  const { accessToken } = useAuth()
  const [status, setStatus] = useState('idle')
  const [lastFix, setLastFix] = useState(null)
  const lastSent = useRef(0)

  useEffect(() => {
    if (!enabled || !jobId) {
      setStatus('idle')
      return undefined
    }
    if (!geolocation) {
      setStatus('unavailable')
      return undefined
    }
    let tracking = null
    let watchId = null
    let cancelled = false
    ;(async () => {
      try {
        const token = await accessToken()
        if (cancelled) return
        tracking = connectDriverTracking({ token, onError: () => setStatus('offline'), ...(connect ? { connect } : {}) })
      } catch {
        setStatus('offline')
      }
      if (cancelled) return
      setStatus('locating')
      watchId = geolocation.watchPosition(
        (pos) => {
          const fix = { lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)) }
          setLastFix(fix)
          setStatus('sharing')
          const now = Date.now()
          if (tracking && now - lastSent.current >= LIVE_PUBLISH_MS && tracking.publish(jobId, fix.lat, fix.lng)) {
            lastSent.current = now
          }
        },
        () => setStatus('denied'),
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
      )
    })()
    return () => {
      cancelled = true
      if (watchId !== null) geolocation.clearWatch(watchId)
      tracking?.close()
    }
  }, [jobId, enabled, geolocation, connect, accessToken])

  return { status, lastFix }
}
