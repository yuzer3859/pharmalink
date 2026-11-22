import { beforeAll, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { createApiClient } from '../auth/apiClient'
import { createAuthService } from '../auth/authService'
import { CatalogContext, createCatalogService } from '../catalog/catalogService'
import { SearchContext, createSearchService } from '../search/searchService'
import { messages, setLanguage, t } from '../auth/strings'
import { pageMessages } from './pages'
import { fakeFetch, ok } from '../test/fakeBackend'
import { categoryTree } from '../test/catalogFixtures'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

const SEARCH = 'GET /search/medicines'

function renderApp(path) {
  const backend = fakeFetch({
    'GET /catalog/categories': ok(categoryTree()),
    'GET /catalog/products': ok({ items: [], meta: { page: 1, size: 4, total: 0 } }),
    [SEARCH]: ok({ items: [], total: 0, page: 1, size: 20 }),
  })
  const api = createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher })
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider service={createAuthService({ api, storage: sessionStorage })}>
        <CatalogContext.Provider value={createCatalogService({ api })}>
          <SearchContext.Provider value={createSearchService({ api })}>
            <App />
          </SearchContext.Provider>
        </CatalogContext.Provider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('the pages in Amharic (Work 143)', () => {
  it('has every reviewed page text in both languages, with the same placeholders', () => {
    const placeholders = (text) => (text.match(/\{\w+\}/g) ?? []).sort()
    for (const [key, am] of Object.entries(pageMessages.am)) {
      expect(pageMessages.en[key], key).toBeTypeOf('string')
      expect(placeholders(am), key).toEqual(placeholders(pageMessages.en[key]))
    }
    expect(Object.keys(pageMessages.am).length).toBeGreaterThan(370)
    // The page text never replaces a sign-in text.
    expect(messages.en['nav.login']).toBe('Sign in')
  })

  it("uses the owner's corrections", () => {
    setLanguage('am')
    expect(t('layout.cart')).toBe('ግዢዎች')
    expect(t('layout.openMenu')).toBe('ምርጫውን ክፈት')
    expect(t('home.hero.title')).toBe('የጤናዎ አገልግሎትን፣ በጥንቃቄ እስከ በርዎ።')
    expect(t('req.stage.open.body', { offered: 3, considering: 2 })).toBe('በአቅራቢያ ላሉ 3 ፋርማሲዎች ተልኳል፤ 2 አሁንም እያጤኑት ነው።')
  })

  it('draws the menu and the page in Amharic, and again in English when the language changes', async () => {
    setLanguage('am')
    renderApp('/search')
    expect(await screen.findByRole('heading', { level: 1, name: 'ፍለጋ' })).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'መድኃኒቶች' }).length).toBeGreaterThan(0)
    expect(await screen.findByText('ከእነዚህ ማጣሪያዎች ጋር የሚዛመድ መድኃኒት የለም።')).toBeTruthy()

    act(() => setLanguage('en'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Search' })).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'Medicines' }).length).toBeGreaterThan(0)
  })

  it('no longer claims 40,000+ patients or 24/7 support on the home page', async () => {
    renderApp('/')
    expect(await screen.findByRole('heading', { level: 1, name: 'Healthcare, delivered with care.' })).toBeTruthy()
    expect(screen.queryByText(/40,000/)).toBeNull()
    expect(screen.queryByText(/24\/7/)).toBeNull()
  })
})
