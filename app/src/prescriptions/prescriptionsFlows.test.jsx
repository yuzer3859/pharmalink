import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { createApiClient } from '../auth/apiClient'
import { createAuthService } from '../auth/authService'
import { CatalogContext, createCatalogService } from '../catalog/catalogService'
import { REFRESH_A, customer, fakeFetch, ok, tokens } from '../test/fakeBackend'
import { categoryTree } from '../test/catalogFixtures'
import { checkFile } from './prescriptionsService'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

const FILE_REF = 'doc:prescription/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222'
const prescription = (over = {}) => ({
  id: 'rx-1',
  status: 'UPLOADED',
  displayStatus: 'UPLOADED',
  fileRef: FILE_REF,
  fileType: 'application/pdf',
  doctorName: 'Abebe',
  hospitalName: 'Black Lion',
  createdAt: '2026-11-08T08:00:00.000Z',
  ...over,
})

function signedInApp(path, routes) {
  sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
  const backend = fakeFetch({
    'POST /auth/token/refresh': ok(tokens('access-2', 'q'.repeat(40))),
    'GET /users/me': ok(customer),
    'GET /catalog/categories': ok(categoryTree()),
    ...routes,
  })
  const api = createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher })
  // The upload goes straight to storage with the browser's fetch; point it at the same script.
  vi.stubGlobal('fetch', backend.fetcher)
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider service={createAuthService({ api, storage: sessionStorage })}>
        <CatalogContext.Provider value={createCatalogService({ api })}>
          <App />
        </CatalogContext.Provider>
      </AuthProvider>
    </MemoryRouter>,
  )
  return backend
}

const pdf = () => new File(['%PDF-1.4 test'], 'rx.pdf', { type: 'application/pdf' })

describe('prescriptions (Work 101)', () => {
  it('uploads the file to storage through the signed link, then records the prescription', async () => {
    const { callsTo } = signedInApp('/prescriptions', {
      'GET /prescriptions': [ok({ items: [], total: 0 }), ok({ items: [prescription()], total: 1 })],
      'POST /prescriptions/uploads': ok({ fileRef: FILE_REF, upload: { url: 'http://storage.test/storage/local/tok', method: 'PUT', headers: { 'Content-Type': 'application/pdf' } } }, 201),
      'PUT /storage/local/tok': ok({}),
      'POST /prescriptions': ok(prescription(), 201),
    })
    await screen.findByText('You have not uploaded a prescription yet.')
    fireEvent.change(screen.getByLabelText('Prescription file'), { target: { files: [pdf()] } })
    fireEvent.change(screen.getByLabelText("Doctor's name (optional)"), { target: { value: 'Abebe' } })
    fireEvent.click(screen.getByRole('button', { name: /Upload prescription/ }))

    expect(await screen.findByText('Uploaded. A pharmacist will check it.')).toBeTruthy()
    expect(callsTo('POST /prescriptions/uploads')[0].body).toEqual({ contentType: 'application/pdf', bytes: 13 })
    expect(callsTo('PUT /storage/local/tok')).toHaveLength(1)
    expect(callsTo('POST /prescriptions')[0].body).toEqual({ fileRef: FILE_REF, fileType: 'application/pdf', doctorName: 'Abebe' })
    expect(await screen.findByText('Waiting for a pharmacist')).toBeTruthy()
  })

  it('refuses a file that is not a prescription file before calling the server', async () => {
    const { callsTo } = signedInApp('/prescriptions', { 'GET /prescriptions': ok({ items: [], total: 0 }) })
    await screen.findByText('You have not uploaded a prescription yet.')
    fireEvent.change(screen.getByLabelText('Prescription file'), { target: { files: [new File(['<html>'], 'x.html', { type: 'text/html' })] } })
    fireEvent.click(screen.getByRole('button', { name: /Upload prescription/ }))
    expect(await screen.findByText('Choose a PDF, JPEG or PNG file.')).toBeTruthy()
    expect(callsTo('POST /prescriptions/uploads')).toHaveLength(0)
  })

  it('opens a stored file through a short-lived link', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const { callsTo } = signedInApp('/prescriptions', {
      'GET /prescriptions': ok({ items: [prescription({ status: 'APPROVED', displayStatus: 'APPROVED' })], total: 1 }),
      'POST /prescriptions/rx-1/file': ok({ url: 'http://storage.test/storage/local/read', expiresAt: '2026-11-08T08:05:00.000Z', contentType: 'application/pdf' }),
    })
    expect(await screen.findByText('Approved')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('http://storage.test/storage/local/read', '_blank', 'noopener'))
    expect(callsTo('POST /prescriptions/rx-1/file')).toHaveLength(1)
  })
})

describe('checkFile', () => {
  it('accepts a PDF, JPEG or PNG up to 10 MB', () => {
    expect(checkFile(pdf())).toBeNull()
    expect(checkFile(null)).toBe('Choose a file.')
    expect(checkFile({ type: 'image/png', size: 11 * 1024 * 1024 })).toBe('The file must be smaller than 10 MB.')
  })
})
