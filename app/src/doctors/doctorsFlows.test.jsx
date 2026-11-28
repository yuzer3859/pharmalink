import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { createApiClient } from '../auth/apiClient'
import { createAuthService } from '../auth/authService'
import { CatalogContext, createCatalogService } from '../catalog/catalogService'
import { DoctorsContext, buildDoctorQuery, createDoctorsService, slotsByDay } from './doctorsService'
import { REFRESH_A, customer, fail, fakeFetch, ok, tokens } from '../test/fakeBackend'
import { categoryTree } from '../test/catalogFixtures'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

beforeEach(() => {
  sessionStorage.clear()
})

const DOCTOR = '11111111-1111-4111-8111-111111111111'
const SLOT = '22222222-2222-4222-8222-222222222222'
const SLOT_2 = '33333333-3333-4333-8333-333333333333'
const APPOINTMENT = '44444444-4444-4444-8444-444444444444'
const START = '2026-12-07T06:00:00.000Z' // Mon 7 Dec, 09:00 in Addis Ababa

const hit = (over = {}) => ({
  doctorId: DOCTOR,
  fullName: 'Dr. Selamawit Bekele',
  fullNameAm: null,
  specialty: 'Cardiology',
  subSpecialties: [],
  languages: ['Amharic'],
  acceptsTelemedicine: true,
  feeInPerson: 50000,
  feeTele: 35000,
  currency: 'ETB',
  practices: [{ providerId: 'p', name: 'Tikur Anbessa Hospital', city: 'Addis Ababa' }],
  nextAvailableAt: START,
  city: 'Addis Ababa',
  ratingAvg: null,
  distanceMeters: null,
  ...over,
})
const doctor = {
  doctorId: DOCTOR,
  fullName: 'Dr. Selamawit Bekele',
  fullNameAm: null,
  specialty: 'Cardiology',
  subSpecialties: ['Echocardiography'],
  qualifications: [],
  yearsExperience: 12,
  bio: 'Adult cardiologist.',
  languages: ['Amharic', 'English'],
  consultationFeeInPerson: 50000,
  consultationFeeTele: 35000,
  currency: 'ETB',
  acceptsTelemedicine: true,
  ratingAvg: 0,
  ratingCount: 0,
  affiliations: [{ providerId: 'p', providerName: 'Tikur Anbessa Hospital', providerType: 'HOSPITAL', departmentId: null, departmentName: 'Cardiology', roleTitle: null, isPrimary: true }],
}
const slot = (id, startAt) => ({ slotId: id, startAt, endAt: new Date(Date.parse(startAt) + 30 * 60_000).toISOString(), appointmentType: 'IN_PERSON', location: { locationId: 'l', providerId: 'p', name: 'Main campus', city: 'Addis Ababa' } })
const appointment = (over = {}) => ({
  appointmentId: APPOINTMENT,
  status: 'CONFIRMED',
  appointmentType: 'IN_PERSON',
  startsAt: START,
  endsAt: '2026-12-07T06:30:00.000Z',
  fee: 50000,
  currency: 'ETB',
  doctor: { doctorId: DOCTOR, fullName: 'Dr. Selamawit Bekele', specialty: 'Cardiology' },
  location: { locationId: 'l', providerId: 'p', name: 'Main campus', city: 'Addis Ababa', providerName: 'Tikur Anbessa Hospital' },
  canChange: true,
  payAt: 'VISIT',
  ...over,
})

function renderApp(path, routes, { signedIn = false } = {}) {
  if (signedIn) sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
  const backend = fakeFetch({
    'GET /catalog/categories': ok(categoryTree()),
    ...(signedIn ? { 'POST /auth/token/refresh': ok(tokens('access-2', 'q'.repeat(40))), 'GET /users/me': ok(customer) } : {}),
    ...routes,
  })
  const api = createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher })
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider service={createAuthService({ api, storage: sessionStorage })}>
        <CatalogContext.Provider value={createCatalogService({ api })}>
          <DoctorsContext.Provider value={createDoctorsService({ api })}>
            <App />
          </DoctorsContext.Provider>
        </CatalogContext.Provider>
      </AuthProvider>
    </MemoryRouter>,
  )
  return backend
}

const params = (call) => Object.fromEntries(new URL(call.url).searchParams)

describe('doctors in the app (Work 171)', () => {
  it('finds doctors, soonest free first, with their next time and fee; filters by video', async () => {
    const { callsTo } = renderApp('/doctors', { 'GET /search/doctors': ok({ items: [hit()], total: 1, match: null, didYouMean: null }) })
    expect(await screen.findByText('Dr. Selamawit Bekele')).toBeTruthy()
    expect(screen.getByText(/Next free: .*09:00/)).toBeTruthy()
    expect(screen.getByText('Tikur Anbessa Hospital')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Dr. Selamawit Bekele/ }).getAttribute('href')).toBe(`/doctors/${DOCTOR}`)
    fireEvent.click(screen.getByRole('checkbox', { name: /Video appointments/ }))
    await waitFor(() => expect(params(callsTo('GET /search/doctors').at(-1))).toMatchObject({ telemedicine: 'true' }))
  })

  it('a signed-out customer sees the doctor and their times, and is asked to sign in to book', async () => {
    renderApp(`/doctors/${DOCTOR}`, {
      [`GET /doctors/${DOCTOR}`]: ok(doctor),
      [`GET /doctors/${DOCTOR}/slots`]: ok({ items: [slot(SLOT, START), slot(SLOT_2, '2026-12-07T06:30:00.000Z')] }),
    })
    expect(await screen.findByRole('heading', { name: 'Dr. Selamawit Bekele' })).toBeTruthy()
    expect(screen.getByText('Adult cardiologist.')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /09:00/ }))
    expect(screen.getByRole('link', { name: 'Sign in to book' }).getAttribute('href')).toBe('/login')
  })

  it('books a time with a reason and shows it in My appointments', async () => {
    const { callsTo } = renderApp(
      `/doctors/${DOCTOR}`,
      {
        [`GET /doctors/${DOCTOR}`]: ok(doctor),
        [`GET /doctors/${DOCTOR}/slots`]: ok({ items: [slot(SLOT, START)] }),
        'POST /appointments': ok(appointment(), 201),
        'GET /appointments': ok({ items: [appointment()] }),
      },
      { signedIn: true },
    )
    fireEvent.click(await screen.findByRole('button', { name: /09:00/ }))
    fireEvent.change(screen.getByLabelText(/What is it about/), { target: { value: 'Chest pain' } })
    fireEvent.click(screen.getByRole('button', { name: /Book this time/ }))
    expect(await screen.findByText('Your appointment is booked. We sent you the details.')).toBeTruthy()
    expect(callsTo('POST /appointments')[0].body).toEqual({ slotId: SLOT, appointmentType: 'IN_PERSON', reasonNote: 'Chest pain' })
    expect(await screen.findByText(/Fee .*500.*paid at the visit/)).toBeTruthy()
  })

  it('says when someone else just took the time', async () => {
    renderApp(
      `/doctors/${DOCTOR}`,
      {
        [`GET /doctors/${DOCTOR}`]: ok(doctor),
        [`GET /doctors/${DOCTOR}/slots`]: ok({ items: [slot(SLOT, START)] }),
        'POST /appointments': fail(409, 'SLOT_UNAVAILABLE'),
      },
      { signedIn: true },
    )
    fireEvent.click(await screen.findByRole('button', { name: /09:00/ }))
    fireEvent.click(screen.getByRole('button', { name: /Book this time/ }))
    expect(await screen.findByText('Someone has just taken this time. Choose another one.')).toBeTruthy()
  })

  it('cancels an appointment, and offers Move to another time', async () => {
    const { callsTo } = renderApp(
      '/appointments',
      {
        'GET /appointments': [ok({ items: [appointment()] }), ok({ items: [] })],
        [`POST /appointments/${APPOINTMENT}/cancel`]: ok(appointment({ status: 'CANCELLED', canChange: false })),
      },
      { signedIn: true },
    )
    expect((await screen.findByRole('link', { name: 'Move' })).getAttribute('href')).toBe(`/doctors/${DOCTOR}?reschedule=${APPOINTMENT}`)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.change(screen.getByLabelText(/Why\?/), { target: { value: 'Feeling better' } })
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }))
    expect(await screen.findByText('Your appointment is cancelled.')).toBeTruthy()
    expect(callsTo(`POST /appointments/${APPOINTMENT}/cancel`)[0].body).toEqual({ reason: 'Feeling better' })
  })

  it('moves an appointment from the doctor page', async () => {
    const { callsTo } = renderApp(
      `/doctors/${DOCTOR}?reschedule=${APPOINTMENT}`,
      {
        [`GET /doctors/${DOCTOR}`]: ok(doctor),
        [`GET /doctors/${DOCTOR}/slots`]: ok({ items: [slot(SLOT_2, '2026-12-07T06:30:00.000Z')] }),
        [`POST /appointments/${APPOINTMENT}/reschedule`]: ok(appointment({ appointmentId: '55555555-5555-4555-8555-555555555555' })),
        'GET /appointments': ok({ items: [] }),
      },
      { signedIn: true },
    )
    expect(await screen.findByRole('heading', { name: 'Choose the new time' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /09:30/ }))
    fireEvent.click(screen.getByRole('button', { name: /Move my appointment here/ }))
    expect(await screen.findByText('Your appointment is moved.')).toBeTruthy()
    expect(callsTo(`POST /appointments/${APPOINTMENT}/reschedule`)[0].body).toEqual({ slotId: SLOT_2 })
  })

  it('sends only validated search parameters and groups times by local day', () => {
    expect(buildDoctorQuery({ q: ' cardio ', providerId: 'nope', telemedicine: 'yes', page: 0 })).toBe('q=cardio&size=20')
    expect(buildDoctorQuery({ specialty: 'Cardiology', telemedicine: true, availableOnly: true, location: { lat: 9, lng: 38 } })).toBe('specialty=Cardiology&telemedicine=true&availableOnly=true&lat=9&lng=38&radiusKm=25&size=20')
    // 22:30Z on the 6th is 01:30 on the 7th in Addis Ababa.
    expect(slotsByDay([slot(SLOT, '2026-12-06T22:30:00.000Z'), slot(SLOT_2, START)]).map((d) => [d.date, d.items.length])).toEqual([['2026-12-07', 2]])
  })
})
