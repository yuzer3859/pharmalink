// Thin fetch wrapper for the PharmaLink backend. Every response is the standard envelope
// `{ success, data, error: { code, message, details }, meta }`; this unwraps `data` on success and
// throws an ApiError carrying the backend's code, message and details otherwise.

export class ApiError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null

export function createApiClient({ baseUrl, fetcher = (...args) => fetch(...args) }) {
  async function request(path, { method = 'GET', body, accessToken } = {}) {
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`

    let response
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach PharmaLink.')
    }

    // 204 (logout) has no body.
    if (response.status === 204) return null

    let payload
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }

    const requestId = isRecord(payload) && isRecord(payload.meta) ? payload.meta.requestId : undefined
    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
      if (error && typeof error.code === 'string') {
        throw new ApiError(response.status, error.code, String(error.message ?? ''), error.details, requestId)
      }
      throw new ApiError(response.status, 'HTTP_ERROR', `Request failed (${response.status}).`, undefined, requestId)
    }
    if (!isRecord(payload) || payload.success !== true || !('data' in payload)) {
      throw new ApiError(response.status, 'MALFORMED_RESPONSE', 'The server sent an unexpected response.', undefined, requestId)
    }
    return payload.data
  }

  return {
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  }
}
