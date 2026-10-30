import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// No test may reach a real server: anything that falls through to the global fetch fails like an
// unreachable network. Tests that need responses inject a scripted fetch (src/test/fakeBackend.js).
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Network access is disabled in tests'))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})
