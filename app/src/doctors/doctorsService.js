import { createContext, useContext, useMemo } from 'react'
import { API_BASE_URL } from '../config/env'
import { ApiError, createApiClient } from '../auth/apiClient'
import { useAuth } from '../auth/AuthContext'
import { t } from '../auth/strings'
import { isUuid } from '../catalog/catalogService'
import { DEFAULT_RADIUS_KM } from '../search/searchService'

// Work 171: doctors (Module 10) in the customer app. Public reads (search, a doctor's page and
// open times) need no sign-in and go through the care service's API client; booking, the
// customer's appointments, cancelling and moving go through the signed-in session.

export const DOCTOR_PAGE_SIZE = 20
export const SLOT_DAYS = 14

const isRecord = (value) => typeof value === 'object' && value !== null
const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', t('common.unexpected'))
const isCoordinate = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** `GET /search/doctors` query string, from allowlisted, validated values only. */
export function buildDoctorQuery({ q, specialty, providerId, telemedicine, availableOnly, location, page } = {}) {
  const params = new URLSearchParams()
  const text = typeof q === 'string' ? q.trim().slice(0, 120) : ''
  if (text) params.set('q', text)
  if (typeof specialty === 'string' && specialty.trim()) params.set('specialty', specialty.trim().slice(0, 120))
  if (isUuid(providerId)) params.set('providerId', providerId)
  if (telemedicine === true) params.set('telemedicine', 'true')
  if (availableOnly === true) params.set('availableOnly', 'true')
  if (location && isCoordinate(location.lat, 90) && isCoordinate(location.lng, 180)) {
    params.set('lat', String(location.lat))
    params.set('lng', String(location.lng))
    params.set('radiusKm', String(location.radiusKm ?? DEFAULT_RADIUS_KM))
  }
  const n = Number(page)
  if (Number.isInteger(n) && n > 1) params.set('page', String(n))
  params.set('size', String(DOCTOR_PAGE_SIZE))
  return params.toString()
}

function readDoctorHit(item) {
  if (!isRecord(item) || !isUuid(item.doctorId) || typeof item.fullName !== 'string') throw malformed()
  return { ...item, practices: Array.isArray(item.practices) ? item.practices : [], languages: Array.isArray(item.languages) ? item.languages : [] }
}

function readSlot(item) {
  if (!isRecord(item) || !isUuid(item.slotId) || typeof item.startAt !== 'string') throw malformed()
  return item
}

function readAppointment(item) {
  if (!isRecord(item) || !isUuid(item.appointmentId) || typeof item.status !== 'string' || !isRecord(item.doctor)) throw malformed()
  return item
}

/** Public doctor reads, over an API client without a session. */
export function createDoctorsService({ api }) {
  return {
    async search(filters, { signal } = {}) {
      const data = await api.get(`/search/doctors?${buildDoctorQuery(filters)}`, { signal })
      if (!isRecord(data) || !Array.isArray(data.items) || !Number.isInteger(data.total)) throw malformed()
      return {
        items: data.items.map(readDoctorHit),
        total: data.total,
        didYouMean: data.match === 'SIMILAR' && typeof data.didYouMean === 'string' ? data.didYouMean : null,
      }
    },
    async doctor(doctorId, { signal } = {}) {
      if (!isUuid(doctorId)) throw new ApiError(404, 'NOT_FOUND', t('common.notFound'))
      const data = await api.get(`/doctors/${doctorId}`, { signal })
      if (!isRecord(data) || !isUuid(data.doctorId)) throw malformed()
      return { ...data, affiliations: Array.isArray(data.affiliations) ? data.affiliations : [], languages: Array.isArray(data.languages) ? data.languages : [] }
    },
    /** Open times, `from` and `to` local dates (at most 31 days); `type` IN_PERSON or TELEMEDICINE. */
    async slots(doctorId, { from, to, type } = {}, { signal } = {}) {
      if (!isUuid(doctorId)) throw new ApiError(404, 'NOT_FOUND', t('common.notFound'))
      const params = new URLSearchParams()
      if (DATE.test(from ?? '')) params.set('from', from)
      if (DATE.test(to ?? '')) params.set('to', to)
      if (type === 'IN_PERSON' || type === 'TELEMEDICINE') params.set('type', type)
      const query = params.toString()
      const data = await api.get(`/doctors/${doctorId}/slots${query ? `?${query}` : ''}`, { signal })
      if (!isRecord(data) || !Array.isArray(data.items)) throw malformed()
      return data.items.map(readSlot)
    },
    async providerDoctors(providerId, { signal } = {}) {
      if (!isUuid(providerId)) return []
      const data = await api.get(`/providers/${providerId}/doctors`, { signal })
      if (!isRecord(data) || !Array.isArray(data.items)) throw malformed()
      return data.items
    },
  }
}

let defaultService
export function getDefaultDoctorsService() {
  if (!defaultService) defaultService = createDoctorsService({ api: createApiClient({ baseUrl: API_BASE_URL }) })
  return defaultService
}

export const DoctorsContext = createContext(null)

/** The public doctors service; tests provide their own through <DoctorsContext.Provider>. */
export function useDoctors() {
  return useContext(DoctorsContext) ?? getDefaultDoctorsService()
}

/** The signed-in customer's appointments. */
export function createAppointmentsService({ request }) {
  return {
    async book({ slotId, appointmentType, reasonNote }) {
      if (!isUuid(slotId)) throw new ApiError(409, 'SLOT_UNAVAILABLE', t('doctors.slotGone'))
      const body = { slotId }
      if (appointmentType === 'IN_PERSON' || appointmentType === 'TELEMEDICINE') body.appointmentType = appointmentType
      if (typeof reasonNote === 'string' && reasonNote.trim()) body.reasonNote = reasonNote.trim().slice(0, 1000)
      return readAppointment(await request('POST', '/appointments', body))
    },
    async mine(scope = 'upcoming') {
      const data = await request('GET', `/appointments?scope=${scope === 'past' ? 'past' : 'upcoming'}`)
      if (!isRecord(data) || !Array.isArray(data.items)) throw malformed()
      return data.items.map(readAppointment)
    },
    async cancel(appointmentId, reason) {
      if (!isUuid(appointmentId)) throw new ApiError(404, 'NOT_FOUND', t('common.notFound'))
      return readAppointment(await request('POST', `/appointments/${appointmentId}/cancel`, typeof reason === 'string' && reason.trim() ? { reason: reason.trim().slice(0, 500) } : {}))
    },
    async reschedule(appointmentId, slotId) {
      if (!isUuid(appointmentId) || !isUuid(slotId)) throw new ApiError(404, 'NOT_FOUND', t('common.notFound'))
      return readAppointment(await request('POST', `/appointments/${appointmentId}/reschedule`, { slotId }))
    },
  }
}

export function useAppointments() {
  const { request } = useAuth()
  return useMemo(() => createAppointmentsService({ request }), [request])
}

/** Today's Addis Ababa date, `YYYY-MM-DD`. */
export const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date())
export const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
/** The Addis Ababa date of an instant, `YYYY-MM-DD`. */
export const localDateOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date(iso))
export const localTime = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
export const localDayLabel = (iso, language = 'en') =>
  new Intl.DateTimeFormat(language === 'am' ? 'am-ET' : 'en-GB', { timeZone: 'Africa/Addis_Ababa', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso))

/** Groups open times by their Addis Ababa date, in order. */
export function slotsByDay(slots) {
  const days = new Map()
  for (const s of slots) {
    const day = localDateOf(s.startAt)
    days.set(day, [...(days.get(day) ?? []), s])
  }
  return [...days.entries()].map(([date, items]) => ({ date, items }))
}

/** What went wrong with a booking change, in the customer's language where we know the case. */
export function appointmentError(error) {
  switch (error?.code) {
    case 'SLOT_UNAVAILABLE':
      return t('doctors.slotGone')
    case 'CANCELLATION_WINDOW_CLOSED':
    case 'RESCHEDULE_WINDOW_CLOSED':
      return t('appointments.tooLate')
    case 'NETWORK_ERROR':
      return t('error.network')
    case 'BUSINESS_RULE_VIOLATION':
      return error?.details?.code === 'TOO_MANY_APPOINTMENTS' ? t('appointments.tooMany') : (error.message || t('common.unexpected'))
    default:
      return t('common.unexpected')
  }
}
