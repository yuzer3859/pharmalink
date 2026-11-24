// Work 147: product pictures. The catalogue sends image URLs; the app shows only an `https://` URL
// or a path on this site (never `//host`, `javascript:` or anything else), whatever the API says.
// Work 150: a picture uploaded by catalogue staff is served by the API, at `/media/...`.
import { API_BASE_URL } from '../config/env'

const SAFE_IMAGE = /^(?:https:\/\/[^\s"'<>]+|\/(?!\/)[^\s"'<>]*)$/

/** The URL when it is safe to put in an <img>, otherwise null. */
export function safeImageUrl(url) {
  if (typeof url !== 'string' || !SAFE_IMAGE.test(url)) return null
  return url.startsWith('/media/') ? `${API_BASE_URL.replace(/\/+$/, '')}${url}` : url
}

/**
 * A representative picture for each shelf category (Work 146 slugs), from the product pictures
 * this site serves. A category not listed here is shown with an icon instead.
 */
export const CATEGORY_PICTURES = {
  'pain-fever': '/products/paracetamol.webp',
  'cold-flu': '/products/cough-syrup.webp',
  digestive: '/products/antacid.webp',
  antibiotics: '/products/amoxicillin.webp',
  vitamins: '/products/omega-3.webp',
  beauty: '/products/lipstick.webp',
  'skin-care': '/products/cleanser.webp',
  'oral-care': '/products/toothbrush.webp',
  'personal-care': '/products/shampoo.webp',
  'baby-mother': '/products/feeding-bottle.webp',
  'first-aid': '/products/first-aid-kit.webp',
  devices: '/products/bp-monitor.webp',
  mobility: '/products/wheelchair.webp',
}

/** The shelves the home page shows, in order, by category slug. */
export const HOME_SHELVES = ['beauty', 'oral-care', 'vitamins', 'devices', 'mobility', 'baby-mother']

/** Pictures that float in the home page hero. */
export const HERO_PICTURES = [
  '/products/lipstick.webp',
  '/products/vitamin-d.webp',
  '/products/toothbrush.webp',
  '/products/thermometer.webp',
  '/products/wheelchair.webp',
]
