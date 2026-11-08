import { io } from 'socket.io-client'
import { API_BASE_URL } from '../config/env'

/**
 * Work 102: live delivery tracking over Module 08's socket.io gateway (`/tracking`). The access
 * token goes in the handshake; the gateway re-authorizes every message. `onView` receives the
 * snapshot from the subscription's acknowledgement, then every `tracking:update`.
 * Returns a function that closes the connection.
 */
export function followDelivery({ jobId, token, onView, onError, connect = io, baseUrl = API_BASE_URL }) {
  const socket = connect(`${baseUrl}/tracking`, { transports: ['websocket'], auth: { token }, reconnection: true })
  socket.on('connect', () => {
    socket.emit('tracking:subscribe', { jobId }, (ack) => {
      if (ack?.ok && ack.data) onView(ack.data)
      else onError?.(ack?.error ?? { code: 'TRACKING_UNAVAILABLE' })
    })
  })
  socket.on('tracking:update', (view) => onView(view))
  socket.on('tracking:error', (error) => onError?.(error))
  socket.on('connect_error', () => onError?.({ code: 'TRACKING_UNAVAILABLE' }))
  return () => {
    socket.emit('tracking:unsubscribe', { jobId })
    socket.disconnect()
  }
}
