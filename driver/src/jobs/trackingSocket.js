import { io } from 'socket.io-client'
import { API_BASE_URL } from '../config/env'

/**
 * Work 120: the driver's side of live tracking (module-08 §9.4, the `/tracking` gateway). The
 * access token goes in the handshake; the gateway takes the driver from the token, never from the
 * message, and only lets the job's assigned driver publish. The customer's order page follows these
 * positions live.
 *
 * Returns `{ publish(jobId, lat, lng), close() }`. A position published while disconnected is dropped,
 * not queued: a stale position must never be replayed as if it were current.
 */
export function connectDriverTracking({ token, onError, connect = io, baseUrl = API_BASE_URL }) {
  const socket = connect(`${baseUrl}/tracking`, { transports: ['websocket'], auth: { token }, reconnection: true })
  socket.on('connect_error', () => onError?.({ code: 'TRACKING_UNAVAILABLE' }))
  socket.on('tracking:error', (error) => onError?.(error))
  return {
    publish(jobId, lat, lng) {
      if (!socket.connected) return false
      socket.emit('tracking:location', { jobId, lat, lng, recordedAt: new Date().toISOString() }, (ack) => {
        if (ack && ack.ok === false) onError?.(ack.error ?? { code: 'TRACKING_REFUSED' })
      })
      return true
    },
    close() {
      socket.disconnect()
    },
  }
}
