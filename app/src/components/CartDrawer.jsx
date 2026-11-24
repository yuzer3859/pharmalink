import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, ShoppingBag, X } from 'lucide-react'
import { Button, Skeleton } from './ui'
import { CartLine, useCartProducts } from './CartLine'
import { useOrders } from '../pages/Checkout'
import { cartChanged, cartItemCount } from '../lib/cartEvents'
import { formatMinorUnits } from '../lib/utils'
import { t } from '../auth/strings'

/**
 * Work 148: the cart slides in from the right, without leaving the page. The customer can change
 * quantities or remove items, sees the running total of the items' prices, and goes on to checkout.
 * Escape, the close button or a click outside closes it; focus moves into it and back.
 */
export default function CartDrawer({ open, onClose }) {
  const orders = useOrders()
  const [cart, setCart] = useState({ status: 'loading', data: null, error: null })
  const panel = useRef(null)

  const load = useCallback(async () => {
    try {
      const data = await orders.cart()
      setCart({ status: 'ready', data, error: null })
      cartChanged(cartItemCount(data))
    } catch {
      setCart({ status: 'error', data: null, error: null })
    }
  }, [orders])

  useEffect(() => {
    if (!open) return undefined
    setCart((c) => ({ ...c, status: c.data ? 'ready' : 'loading' }))
    load()
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const previous = document.activeElement
    panel.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [open, load, onClose])

  const items = cart.data?.items ?? []
  const products = useCartProducts(items)
  const subtotal = items.every((i) => i.indicativePrice != null)
    ? items.reduce((sum, i) => sum + i.indicativePrice * i.quantity, 0)
    : null

  async function change(item, quantity) {
    try {
      if (quantity <= 0) await orders.removeItem(item.id)
      else await orders.setQuantity(item.id, quantity)
      await load()
    } catch (error) {
      setCart((c) => ({ ...c, error: error?.message || t('checkout.cart.updateFailed') }))
    }
  }

  // Rendered into <body>: the header's frosted glass would otherwise clip a fixed panel.
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={t('layout.cart')}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-surface shadow-2xl focus:outline-none"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 320 }}
          >
            <header className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="flex items-center gap-2 font-display text-h3 text-fg">
                <ShoppingBag className="h-5 w-5 text-brand-500" aria-hidden="true" /> {t('layout.cart')}
                {items.length > 0 && <span className="rounded-full bg-brand-500/12 px-2 py-0.5 text-caption font-bold text-brand-700 dark:text-brand-300">{cartItemCount(cart.data)}</span>}
              </h2>
              <button type="button" onClick={onClose} aria-label={t('common.close')} className="grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg">
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5">
              {cart.status === 'loading' && <div className="space-y-3 py-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
              {cart.status === 'error' && <p role="alert" className="py-6 text-body text-muted">{t('checkout.loadFailed')}</p>}
              {cart.status === 'ready' && items.length === 0 && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center gap-4 py-16 text-center">
                  <span className="grid h-20 w-20 place-items-center rounded-full bg-brand-500/10 text-brand-500">
                    <ShoppingBag className="h-9 w-9" aria-hidden="true" />
                  </span>
                  <p className="text-body-lg font-semibold text-fg">{t('checkout.empty')}</p>
                  <Button as={Link} to="/search" variant="secondary" onClick={onClose}>{t('common.findMedicines')}</Button>
                </motion.div>
              )}
              {cart.status === 'ready' && items.length > 0 && (
                <div className="divide-y divide-border">
                  <AnimatePresence initial={false}>
                    {items.map((item) => (
                      <CartLine key={item.id} compact item={item} product={products[item.catalogProductId]} onChange={change} />
                    ))}
                  </AnimatePresence>
                </div>
              )}
              {cart.error && <p role="alert" className="pb-3 text-caption text-danger">{cart.error}</p>}
            </div>

            {items.length > 0 && (
              <footer className="space-y-3 border-t border-border bg-surface-2/50 px-5 py-4">
                {subtotal != null && (
                  <div className="flex items-baseline justify-between">
                    <span className="text-body text-muted">{t('checkout.items')}</span>
                    <span className="font-display text-h3 font-bold text-fg" data-testid="drawer-subtotal">{formatMinorUnits(subtotal, 'ETB')}</span>
                  </div>
                )}
                <Button as={Link} to="/checkout" size="lg" className="w-full" onClick={onClose}>
                  {t('common.goToCheckout')} <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </footer>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}
