import { describe, expect, it } from 'vitest'
import { messages, setLanguage, t } from './strings'

const placeholders = (text) => (text.match(/\{\w+\}/g) ?? []).sort()

describe('the Amharic screens (Work 131)', () => {
  it('translates only keys that exist in English, keeping every placeholder', () => {
    for (const [key, text] of Object.entries(messages.am)) {
      expect(messages.en[key], key).toBeTypeOf('string')
      expect(placeholders(text), key).toEqual(placeholders(messages.en[key]))
      expect(text.trim().length, key).toBeGreaterThan(0)
    }
  })

  it('shows Amharic when chosen, English for an untranslated key, and English for an unknown language', () => {
    setLanguage('am')
    expect(t('account.title')).toBe('የእኔ መለያ')
    expect(t('verify.sentTo', { target: 'a@b.et' })).toBe('ወደ a@b.et ባለ ስድስት አሃዝ ኮድ ልከናል።')
    expect(t('account.languageSave')).toBe(messages.en['account.languageSave'])
    setLanguage('fr')
    expect(t('account.title')).toBe('My account')
  })
})
