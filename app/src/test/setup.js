import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { setLanguage } from '../auth/strings'

// No test may reach a real server: anything that falls through to the global fetch fails like an
// unreachable network. Tests that need responses inject a scripted fetch (src/test/fakeBackend.js).
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Network access is disabled in tests'))))
  // Work 147: the pages reveal sections as they scroll into view. jsdom has no
  // IntersectionObserver; this one reports every element as visible straight away.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback) {
        this.callback = callback
      }
      observe(target) {
        this.callback([{ target, isIntersecting: true, intersectionRatio: 1 }], this)
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // Work 131: the screen language is remembered; every test starts in English.
  setLanguage('en')
  sessionStorage.clear()
  localStorage.clear()
})
