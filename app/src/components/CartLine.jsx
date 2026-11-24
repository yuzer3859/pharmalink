import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Minus, Plus, Trash2 } from 'lucide-react'
import { Button } from './ui'
import ProductImage from './ProductImage'
import { useCatalog } from '../catalog/catalogService'
import { productName } from '../catalog/format'
import { formatMinorUnits } from '../lib/utils'
import { t } from '../auth/strings'

/**
 * Work 148: the name and picture of each product in the cart (the cart holds only product ids),
 * looked up once per product from the catalogue.
 */
export function useCartProducts(items) {
  const catalog = useCatalog()
  const [products, setProducts] = useState({})
  const ids = [...new Set((items ?? []).map((i) => i.catalogProductId))].join(',')
  useEffect(() => {
    let active = true
    for (const id of ids ? ids.split(',') : []) {
      if (products[id]) continue
      catalog
        .getProduct(id)
        .then((p) => active && setProducts((all) => ({ ...all, [id]: { name: productName(p), imageUrl: p.imageUrl ?? null } })))
        .catch(() => {})
    }
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, ids])
  return products
}

const money = (amount) => formatMinorUnits(amount, 'ETB') ?? '—'

/** Work 148: one cart line with its picture, price and quantity controls. */
export function CartLine({ item, product, onChange, compact = false }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -24 }}
      className={compact ? 'flex items-center gap-3 py-3' : 'flex items-center gap-3 p-4'}
      data-testid="cart-item"
    >
      <ProductImage src={product?.imageUrl} iconSize="h-5 w-5" className={compact ? 'h-14 w-14 shrink-0 rounded-xl' : 'h-16 w-16 shrink-0 rounded-2xl'} />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-body font-semibold text-fg">{product?.name ?? t('common.loading')}</p>
        <p className="text-caption text-muted">
          {item.indicativePrice != null ? t('checkout.item.each', { price: money(item.indicativePrice) }) : t('checkout.item.priceAtCheckout')}
          {item.requiresRx ? ` ${t('checkout.item.rxNeeded')}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-0.5 rounded-full border border-border bg-surface-2/60 p-0.5">
        <Button variant="ghost" size="sm" className="h-8 w-8 rounded-full p-0" aria-label={t('checkout.item.decrease')} onClick={() => onChange(item, item.quantity - 1)}><Minus className="h-4 w-4" /></Button>
        <motion.span key={item.quantity} initial={{ scale: 1.4 }} animate={{ scale: 1 }} className="w-7 text-center text-body font-semibold" aria-label={t('common.quantity')}>{item.quantity}</motion.span>
        <Button variant="ghost" size="sm" className="h-8 w-8 rounded-full p-0" aria-label={t('checkout.item.increase')} onClick={() => onChange(item, item.quantity + 1)}><Plus className="h-4 w-4" /></Button>
      </div>
      <Button variant="ghost" size="sm" className="h-8 w-8 rounded-full p-0 text-muted hover:text-danger" aria-label={t('checkout.item.remove')} onClick={() => onChange(item, 0)}><Trash2 className="h-4 w-4" /></Button>
    </motion.div>
  )
}
