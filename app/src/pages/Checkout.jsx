import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, CreditCard, MapPin, Minus, Pill, Plus, RefreshCw, ShieldCheck, Smartphone, Trash2, Truck, Wallet, XCircle } from 'lucide-react'
import { Badge, Button, Card, Input, Skeleton } from '../components/ui'
import { formatMinorUnits } from '../lib/utils'
import { useAuth } from '../auth/AuthContext'
import { useCatalog } from '../catalog/catalogService'
import { productName } from '../catalog/format'
import { PAYMENT_METHODS, createOrdersService, newIdempotencyKey } from '../orders/ordersService'
import { requestLocation } from '../search/searchService'

const METHOD_ICONS = { COD: Wallet, TELEBIRR: Smartphone, CARD: CreditCard }

/** The test gateway's token field appears only in a build that turns test mode on (staging). */
const PAYMENTS_TEST_MODE = import.meta.env.VITE_PAYMENTS_TEST_MODE === 'true'

export function useOrders() {
  const { request } = useAuth()
  return useMemo(() => createOrdersService({ request }), [request])
}

const money = (amount, currency = 'ETB') => formatMinorUnits(amount, currency) ?? '—'

/**
 * Work 105: a delivery address needs its map location (the backend requires `lat`/`lng` to route
 * the driver and measure the distance), so the customer shares it from the browser, once, here.
 * The location goes only into this address.
 */
export function AddressForm({ onSaved, orders, locate = requestLocation }) {
  const [form, setForm] = useState({ recipientName: '', recipientPhone: '', city: 'Addis Ababa', addressLine: '' })
  const [location, setLocation] = useState({ status: 'none', point: null })
  const [state, setState] = useState({ saving: false, error: null })
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))
  async function useMyLocation() {
    setLocation({ status: 'locating', point: null })
    const point = await locate()
    setLocation(point ? { status: 'found', point } : { status: 'refused', point: null })
  }
  async function save(e) {
    e.preventDefault()
    if (!location.point) {
      setState({ saving: false, error: 'Share the delivery location first, so the driver can find you.' })
      return
    }
    setState({ saving: true, error: null })
    try {
      const saved = await orders.addAddress({ ...form, ...location.point })
      setState({ saving: false, error: null })
      onSaved(saved)
    } catch (error) {
      setState({ saving: false, error: error?.message || 'The address could not be saved.' })
    }
  }
  return (
    <form onSubmit={save} className="grid gap-3 sm:grid-cols-2" aria-label="New delivery address">
      <Input aria-label="Recipient name" placeholder="Recipient name" value={form.recipientName} onChange={set('recipientName')} required />
      <Input aria-label="Recipient phone" placeholder="+2519…" value={form.recipientPhone} onChange={set('recipientPhone')} required />
      <Input aria-label="City" placeholder="City" value={form.city} onChange={set('city')} required />
      <Input aria-label="Street and building" placeholder="Street, building" value={form.addressLine} onChange={set('addressLine')} required />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="button" variant="secondary" onClick={useMyLocation} disabled={location.status === 'locating'}>
          {location.status === 'locating' ? 'Finding your location…' : location.point ? 'Update my location' : 'Use my current location'}
        </Button>
        <span className="text-caption text-muted" aria-live="polite">
          {location.status === 'found' && 'Location shared for this address.'}
          {location.status === 'refused' && 'Your location is unavailable. Allow location access in the browser and try again.'}
          {location.status === 'none' && 'The driver needs the delivery location.'}
        </span>
      </div>
      {state.error && <p role="alert" className="text-caption text-danger sm:col-span-2">{state.error}</p>}
      <Button type="submit" variant="secondary" disabled={state.saving || !location.point} className="sm:col-span-2">{state.saving ? 'Saving…' : 'Save address'}</Button>
    </form>
  )
}

/**
 * Work 100: checkout on the real API (Module 06, with Module 07's payment). The cart, addresses,
 * the server's quote, then either cash on delivery or a gateway payment. A declined payment
 * cancels the order and releases its stock on the server; the customer can put the items back in
 * the cart and try again.
 */
export default function Checkout() {
  const orders = useOrders()
  const catalog = useCatalog()
  const [cart, setCart] = useState({ status: 'loading', data: null })
  const [names, setNames] = useState({})
  const [addresses, setAddresses] = useState({ status: 'loading', items: [] })
  const [addressId, setAddressId] = useState('')
  const [adding, setAdding] = useState(false)
  const [quote, setQuote] = useState({ status: 'idle', data: null, error: null })
  const [method, setMethod] = useState('COD')
  const [token, setToken] = useState('')
  const [placing, setPlacing] = useState(false)
  const [outcome, setOutcome] = useState(null)
  const [cartError, setCartError] = useState(null)
  const idempotencyKey = useRef(newIdempotencyKey())

  const loadCart = useCallback(async () => {
    try {
      const data = await orders.cart()
      setCart({ status: 'ready', data })
      for (const item of data.items) {
        if (names[item.catalogProductId]) continue
        catalog
          .getProduct(item.catalogProductId)
          .then((p) => setNames((n) => ({ ...n, [item.catalogProductId]: productName(p) })))
          .catch(() => {})
      }
    } catch {
      setCart({ status: 'error', data: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, catalog])

  useEffect(() => {
    loadCart()
    orders
      .addresses()
      .then((items) => {
        setAddresses({ status: 'ready', items })
        const preferred = items.find((a) => a.isDefault) ?? items[0]
        if (preferred) setAddressId(preferred.id)
      })
      .catch(() => setAddresses({ status: 'error', items: [] }))
  }, [orders, loadCart])

  const items = cart.data?.items ?? []
  const itemsKey = items.map((i) => `${i.id}:${i.quantity}`).join(',')

  useEffect(() => {
    if (!addressId || items.length === 0) return setQuote({ status: 'idle', data: null, error: null })
    let active = true
    setQuote((q) => ({ ...q, status: 'loading', error: null }))
    orders
      .quote(addressId)
      .then((data) => active && setQuote({ status: 'ready', data, error: null }))
      .catch((error) => active && setQuote({ status: 'error', data: null, error }))
    idempotencyKey.current = newIdempotencyKey()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, addressId, itemsKey])

  async function change(item, quantity) {
    setCartError(null)
    try {
      if (quantity <= 0) await orders.removeItem(item.id)
      else await orders.setQuantity(item.id, quantity)
      await loadCart()
    } catch (error) {
      setCartError(error?.message || 'The cart could not be updated.')
    }
  }

  async function place() {
    setPlacing(true)
    try {
      const order = await orders.placeOrder({ addressId, method, token: PAYMENTS_TEST_MODE ? token.trim() : undefined, idempotencyKey: idempotencyKey.current })
      setOutcome({ kind: 'placed', order })
    } catch (error) {
      if (error?.code === 'PAYMENT_AUTH_FAILED') {
        setOutcome({ kind: 'declined', message: error.message, orderId: error.details?.orderId ?? null })
      } else {
        setOutcome({ kind: 'error', message: error?.message || 'The order could not be placed.' })
      }
    } finally {
      setPlacing(false)
      idempotencyKey.current = newIdempotencyKey()
    }
  }

  async function putBack() {
    if (!outcome?.orderId) return
    try {
      const detail = await orders.order(outcome.orderId)
      await orders.rebuildCart(detail.lines ?? [])
      setOutcome(null)
      await loadCart()
    } catch (error) {
      setOutcome({ ...outcome, message: error?.message || outcome.message })
    }
  }

  if (outcome?.kind === 'placed') {
    const o = outcome.order
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-success/15 text-success">
          <Check className="h-10 w-10" strokeWidth={3} aria-hidden="true" />
        </div>
        <h1 className="mt-5 font-display text-h1 text-fg">Order placed</h1>
        <p className="mt-2 text-body text-muted">
          Order <span className="font-semibold text-fg">{o.orderNumber}</span> · {money(o.grandTotal, o.currency)}
        </p>
        <p className="mt-1 text-caption text-muted">
          {o.isCod ? 'Pay the driver in cash when it arrives.' : o.payment?.status === 'AUTHORIZED' ? 'Payment approved.' : 'Waiting for the payment to be confirmed.'}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button as={Link} to={`/orders/${o.orderId}`} size="lg"><Truck className="h-4 w-4" aria-hidden="true" /> Follow your order</Button>
          <Button as={Link} to="/search" variant="ghost">Continue shopping</Button>
        </div>
      </div>
    )
  }

  if (cart.status === 'loading') {
    return <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
  }
  if (cart.status === 'error') {
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="text-body text-fg">Your cart could not be loaded.</p>
        <Button variant="secondary" size="sm" onClick={loadCart}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again</Button>
      </Card>
    )
  }

  const totals = quote.data?.totals
  const rxBlocked = quote.data?.rxGateResult && quote.data.rxGateResult.allowed === false
  const canPlace = items.length > 0 && addressId && quote.status === 'ready' && !rxBlocked && !placing

  return (
    <div className="space-y-6">
      <h1 className="font-display text-h1 text-fg">Checkout</h1>

      {outcome?.kind === 'declined' && (
        <Card role="alert" className="flex flex-col gap-3 border-danger/40 p-4">
          <p className="flex items-center gap-2 text-body font-semibold text-fg"><XCircle className="h-5 w-5 text-danger" aria-hidden="true" /> Payment declined</p>
          <p className="text-caption text-muted">{outcome.message} Your order was cancelled and nothing was charged.</p>
          {outcome.orderId && <Button variant="secondary" size="sm" onClick={putBack}>Put the items back in my cart</Button>}
        </Card>
      )}
      {outcome?.kind === 'error' && <p role="alert" className="text-caption text-danger">{outcome.message}</p>}

      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <Pill className="h-8 w-8 text-subtle" aria-hidden="true" />
          <p className="text-body text-fg">Your cart is empty.</p>
          <Button as={Link} to="/search" variant="secondary">Find medicines</Button>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card className="divide-y divide-border">
              {items.map((item) => (
                <div key={item.id} className="flex items-center gap-3 p-4" data-testid="cart-item">
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-fg">{names[item.catalogProductId] ?? 'Loading…'}</p>
                    <p className="text-caption text-muted">
                      {item.indicativePrice != null ? `${money(item.indicativePrice)} each` : 'Price at checkout'}
                      {item.requiresRx ? ' · prescription needed' : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" aria-label="Decrease quantity" onClick={() => change(item, item.quantity - 1)}><Minus className="h-4 w-4" /></Button>
                    <span className="w-8 text-center text-body" aria-label="Quantity">{item.quantity}</span>
                    <Button variant="ghost" size="sm" aria-label="Increase quantity" onClick={() => change(item, item.quantity + 1)}><Plus className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="sm" aria-label="Remove" onClick={() => change(item, 0)}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>
              ))}
            </Card>
            {cartError && <p role="alert" className="text-caption text-danger">{cartError}</p>}

            <Card className="space-y-3 p-4">
              <h2 className="flex items-center gap-2 text-h3 text-fg"><MapPin className="h-5 w-5 text-brand-500" aria-hidden="true" /> Delivery address</h2>
              {addresses.items.map((a) => (
                <label key={a.id} className="flex items-start gap-3 rounded-xl border border-border p-3">
                  <input type="radio" name="address" value={a.id} checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                  <span className="text-body text-fg">
                    {a.recipientName} · {a.addressLine}, {a.city}
                  </span>
                </label>
              ))}
              {addresses.status === 'ready' && addresses.items.length === 0 && !adding && <p className="text-caption text-muted">Add an address to see your delivery fee.</p>}
              {adding ? (
                <AddressForm
                  orders={orders}
                  onSaved={(saved) => {
                    setAddresses((s) => ({ ...s, items: [...s.items, saved] }))
                    setAddressId(saved.id)
                    setAdding(false)
                  }}
                />
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>Add a new address</Button>
              )}
            </Card>

            <Card className="space-y-3 p-4">
              <h2 className="text-h3 text-fg">Payment</h2>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Payment method">
                {PAYMENT_METHODS.map((m) => {
                  const Icon = METHOD_ICONS[m.id]
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={method === m.id}
                      onClick={() => setMethod(m.id)}
                      className={`flex items-center gap-3 rounded-xl border p-3 text-left ${method === m.id ? 'border-brand-500 bg-brand-500/5' : 'border-border'}`}
                    >
                      <Icon className="h-5 w-5 text-brand-500" aria-hidden="true" />
                      <span><span className="block text-body font-semibold text-fg">{m.label}</span><span className="text-caption text-muted">{m.desc}</span></span>
                    </button>
                  )
                })}
              </div>
              {PAYMENTS_TEST_MODE && method !== 'COD' && (
                <div>
                  <Input aria-label="Test gateway token" placeholder="Test token (e.g. test-decline)" value={token} onChange={(e) => setToken(e.target.value)} maxLength={512} />
                  <p className="mt-1 text-caption text-subtle">Test mode: no real money moves. The token test-decline makes the payment fail.</p>
                </div>
              )}
            </Card>
          </div>

          <Card className="h-fit space-y-3 p-4" aria-label="Order summary">
            <h2 className="text-h3 text-fg">Summary</h2>
            {quote.status === 'loading' && <Skeleton className="h-24" />}
            {quote.status === 'error' && <p role="alert" className="text-caption text-danger">{quote.error?.message || 'The total could not be calculated.'}</p>}
            {quote.status === 'idle' && <p className="text-caption text-muted">Choose an address to see the total.</p>}
            {totals && (
              <dl className="space-y-1 text-body">
                <div className="flex justify-between"><dt className="text-muted">Items</dt><dd>{money(totals.subtotal, totals.currency)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted">Delivery</dt><dd>{money(totals.deliveryFee, totals.currency)}</dd></div>
                {totals.discountTotal > 0 && <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd>−{money(totals.discountTotal, totals.currency)}</dd></div>}
                <div className="flex justify-between border-t border-border pt-2 font-semibold"><dt>Total</dt><dd data-testid="grand-total">{money(totals.grandTotal, totals.currency)}</dd></div>
              </dl>
            )}
            {rxBlocked && (
              <p className="text-caption text-warning">
                A prescription is needed for an item in your cart. <Link to="/prescriptions" className="font-semibold underline">Upload a prescription</Link>
              </p>
            )}
            <Button size="lg" className="w-full" disabled={!canPlace} onClick={place}>
              {placing ? 'Placing order…' : method === 'COD' ? 'Place order' : 'Pay and place order'}
            </Button>
            <p className="flex items-center gap-1.5 text-caption text-subtle"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Licensed pharmacies only. The pharmacy confirms your order.</p>
          </Card>
        </div>
      )}
    </div>
  )
}
