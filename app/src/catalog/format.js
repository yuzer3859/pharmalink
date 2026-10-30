import { formatMinorUnits } from '../lib/utils'
import { AVAILABILITY_LIMIT } from './catalogService'

// Presentation helpers for catalog data. They only rearrange what the API returned; nothing here
// supplies a value the backend didn't send.

/** "COLD_CHAIN" -> "Cold chain". */
export function humanize(value) {
  if (typeof value !== 'string' || !value) return null
  const text = value.replace(/_/g, ' ').toLowerCase()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const UNIT_LABELS = { MG: 'mg', ML: 'ml', G: 'g', MCG: 'mcg', IU: 'IU', PERCENT: '%' }

export function strength(product) {
  if (product?.strengthValue == null || !product.strengthUnit) return null
  const unit = UNIT_LABELS[product.strengthUnit] ?? product.strengthUnit
  return unit === '%' ? `${product.strengthValue}%` : `${product.strengthValue} ${unit}`
}

export function productName(product) {
  return product?.nameEn || product?.brandName || product?.genericName || product?.nameAm || 'Unnamed product'
}

/** Generic name (when it isn't already the title), dosage form and strength. */
export function productDetailsLine(product) {
  const name = productName(product)
  return [
    product?.genericName && product.genericName !== name ? product.genericName : null,
    humanize(product?.dosageForm),
    strength(product),
  ].filter(Boolean).join(' · ')
}

export function categoryName(category) {
  return category?.nameEn || category?.nameAm || category?.slug || ''
}

/**
 * Active categories as a flat, depth-annotated list for a select, keeping only those that apply to
 * the chosen product type (`BOTH`, or the type itself). An inactive parent hides its subtree.
 */
export function flattenCategories(tree, type) {
  const out = []
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      if (node.isActive === false) continue
      const applies = !type || node.appliesTo === 'BOTH' || node.appliesTo === type
      if (applies) out.push({ id: node.id, label: categoryName(node), depth })
      walk(node.children ?? [], applies ? depth + 1 : depth)
    }
  }
  walk(tree ?? [], 0)
  return out
}

/**
 * Aggregates availability listings: how many were returned and the selling-price range per
 * currency. Integer comparisons only; amounts stay in minor units until formatted.
 */
export function summarizeAvailability(items) {
  const byCurrency = new Map()
  for (const item of items) {
    const range = byCurrency.get(item.currency)
    if (!range) byCurrency.set(item.currency, { currency: item.currency, min: item.price, max: item.price })
    else {
      if (item.price < range.min) range.min = item.price
      if (item.price > range.max) range.max = item.price
    }
  }
  const ranges = [...byCurrency.values()].map((r) => {
    const min = formatMinorUnits(r.min, r.currency)
    const max = formatMinorUnits(r.max, r.currency)
    return { ...r, label: min === max ? min : `${min} – ${max}` }
  })
  return { count: items.length, atLeast: items.length >= AVAILABILITY_LIMIT, ranges }
}
