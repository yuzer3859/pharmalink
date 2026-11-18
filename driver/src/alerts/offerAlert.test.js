import { describe, expect, it } from 'vitest'
import { newOfferIds, playOfferAlert } from './offerAlert'

describe('the new-offer alert (Work 141)', () => {
  it('finds the offers not seen before', () => {
    expect(newOfferIds(new Set(['a']), [{ offerId: 'a' }, { offerId: 'b' }])).toEqual(['b'])
    expect(newOfferIds(new Set(), undefined)).toEqual([])
  })

  it('does nothing, without failing, where the browser has no sound', () => {
    expect(() => playOfferAlert()).not.toThrow()
  })
})
