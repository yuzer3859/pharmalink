import { ApiError } from '../auth/apiClient'

// Work 101: the customer's prescriptions (Module 05) with their files in document storage. The file
// goes straight to storage through a signed, short-lived link; the API then records it.

export const PRESCRIPTION_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png']
export const MAX_PRESCRIPTION_BYTES = 10 * 1024 * 1024

const isRecord = (value) => typeof value === 'object' && value !== null
const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', 'The server sent an unexpected response.')

/** A refusal before any network call: the wrong kind of file, or too big. */
export function checkFile(file) {
  if (!file) return 'Choose a file.'
  if (!PRESCRIPTION_FILE_TYPES.includes(file.type)) return 'Choose a PDF, JPEG or PNG file.'
  if (file.size < 1 || file.size > MAX_PRESCRIPTION_BYTES) return 'The file must be smaller than 10 MB.'
  return null
}

export function createPrescriptionsService({ request, fetcher = (...args) => fetch(...args) }) {
  return {
    async list() {
      const data = await request('GET', '/prescriptions?page=1&size=50')
      if (!isRecord(data) || !Array.isArray(data.items)) throw malformed()
      return data.items
    },

    /** Uploads the file to storage, then records the prescription. Returns the prescription. */
    async upload(file, { doctorName, hospitalName } = {}) {
      const problem = checkFile(file)
      if (problem) throw new ApiError(400, 'VALIDATION_ERROR', problem)
      const issued = await request('POST', '/prescriptions/uploads', { contentType: file.type, bytes: file.size })
      if (!isRecord(issued) || typeof issued.fileRef !== 'string' || !isRecord(issued.upload) || typeof issued.upload.url !== 'string') {
        throw malformed()
      }
      let stored
      try {
        stored = await fetcher(issued.upload.url, {
          method: issued.upload.method ?? 'PUT',
          headers: { ...(issued.upload.headers ?? {}), 'Content-Type': file.type },
          body: file,
        })
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', 'The file could not be uploaded. Check your connection and try again.')
      }
      if (!stored.ok) throw new ApiError(stored.status, 'UPLOAD_FAILED', 'The file could not be uploaded. Try again.')
      const body = { fileRef: issued.fileRef, fileType: file.type }
      if (doctorName?.trim()) body.doctorName = doctorName.trim()
      if (hospitalName?.trim()) body.hospitalName = hospitalName.trim()
      return request('POST', '/prescriptions', body)
    },

    /** A 5-minute link to the customer's own file. */
    async fileLink(prescriptionId) {
      const data = await request('POST', `/prescriptions/${encodeURIComponent(prescriptionId)}/file`)
      if (!isRecord(data) || typeof data.url !== 'string') throw malformed()
      return data
    },
  }
}
