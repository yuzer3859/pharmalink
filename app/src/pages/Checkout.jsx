import { useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  MapPin, CreditCard, Smartphone, Wallet, Truck, ShieldCheck, Lock,
  Minus, Plus, Trash2, Check, Pill,
} from 'lucide-react'
import { Button, Card, Badge, Input } from '../components/ui'
import { cart as initialCart } from '../data/mock'
import { formatETB } from '../lib/utils'

const methods = [
  { id: 'telebirr', label: 'Telebirr', desc: 'Mobile wallet', icon: Smartphone },
  { id: 'card', label: 'Card', desc: 'Visa · Mastercard', icon: CreditCard },
  { id: 'cbe', label: 'CBE Birr', desc: 'Bank transfer', icon: Wallet },
]

export default function Checkout() {
  const [cart, setCart] = useState(initialCart)
  const [method, setMethod] = useState('telebirr')
  const [placing, setPlacing] = useState(false)
  const [done, setDone] = useState(false)

  const setQty = (id, delta) =>
    setCart((c) => c.map((i) => (i.id === id ? { ...i, qty: Math.max(1, i.qty + delta) } : i)))
  const remove = (id) => setCart((c) => c.filter((i) => i.id !== id))

  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0)
  const delivery = cart.length ? 60 : 0
  const total = subtotal + delivery

  const place = () => {
    setPlacing(true)
    setTimeout(() => { setPlacing(false); setDone(true) }, 1400)
  }

  if (done) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-success/15 text-success">
          <Check className="h-10 w-10" strokeWidth={3} />
        </motion.div>
        <h1 className="mt-5 font-display text-h1 text-fg">Order placed!</h1>
        <p className="mt-2 text-body text-muted">Your order <span className="font-semibold text-fg">#PL-48213</span> is confirmed. We'll notify you at every step.</p>
        <div className="mt-6 flex flex-col gap-2">
          <Button as={Link} to="/tracking" size="lg"><Truck className="h-4 w-4" /> Track my order</Button>
          <Button as={Link} to="/" variant="ghost">Continue shopping</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="font-display text-h1 text-fg">Checkout</h1>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-5 lg:col-span-2">
          {/* Delivery address */}
          <Card className="p-5">
            <div className="mb-4 flex items-center gap-2">
              <MapPin className="h-5 w-5 text-brand-600" />
              <h2 className="text-h3 text-fg">Delivery address</h2>
            </div>
            <div className="flex items-start justify-between rounded-2xl border border-brand-500/40 bg-brand-500/8 p-4">
              <div>
                <p className="text-body font-semibold text-fg">Home · Meron Alemu</p>
                <p className="text-caption text-muted">Bole, Rwanda St, Bldg 4, Addis Ababa</p>
                <p className="text-caption text-muted">+251 91 234 5678</p>
              </div>
              <Badge tone="brand" dot>Default</Badge>
            </div>
            <Button variant="ghost" size="sm" className="mt-2">+ Add new address</Button>
          </Card>

          {/* Cart items */}
          <Card className="p-5">
            <h2 className="mb-4 text-h3 text-fg">Your items</h2>
            <ul className="space-y-3">
              <AnimatePresence initial={false}>
                {cart.map((i) => (
                  <motion.li key={i.id} layout
                    initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                    className="flex items-center gap-3 overflow-hidden">
                    <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-surface-2 text-brand-500">
                      <Pill className="h-6 w-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-semibold text-fg">{i.name}</p>
                      <p className="text-caption text-muted">{i.form} · {i.pharmacy}</p>
                    </div>
                    <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
                      <button onClick={() => setQty(i.id, -1)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2" aria-label="Decrease"><Minus className="h-4 w-4" /></button>
                      <span className="w-6 text-center text-caption font-semibold text-fg">{i.qty}</span>
                      <button onClick={() => setQty(i.id, 1)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2" aria-label="Increase"><Plus className="h-4 w-4" /></button>
                    </div>
                    <span className="w-20 text-right text-body font-semibold text-fg">{formatETB(i.price * i.qty)}</span>
                    <button onClick={() => remove(i.id)} className="grid h-8 w-8 place-items-center rounded-lg text-subtle hover:bg-danger/10 hover:text-danger" aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </Card>

          {/* Payment */}
          <Card className="p-5">
            <div className="mb-4 flex items-center gap-2">
              <Lock className="h-5 w-5 text-brand-600" />
              <h2 className="text-h3 text-fg">Payment method</h2>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {methods.map((m) => (
                <button key={m.id} onClick={() => setMethod(m.id)}
                  className={'flex items-center gap-3 rounded-2xl border p-3.5 text-left transition-all ' +
                    (method === m.id ? 'border-brand-500 bg-brand-500/8 shadow-glow' : 'border-border hover:border-brand-500/40')}>
                  <span className={'grid h-10 w-10 place-items-center rounded-xl ' + (method === m.id ? 'bg-brand-500 text-white' : 'bg-surface-2 text-muted')}>
                    <m.icon className="h-5 w-5" />
                  </span>
                  <span>
                    <span className="block text-body font-semibold text-fg">{m.label}</span>
                    <span className="block text-caption text-muted">{m.desc}</span>
                  </span>
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              {method === 'card' && (
                <motion.div key="card" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                  className="mt-4 space-y-3 overflow-hidden">
                  <Input placeholder="Card number  ·  0000 0000 0000 0000" icon={CreditCard} />
                  <div className="grid grid-cols-2 gap-3">
                    <Input placeholder="MM / YY" />
                    <Input placeholder="CVC" />
                  </div>
                </motion.div>
              )}
              {method === 'telebirr' && (
                <motion.div key="tb" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                  className="mt-4 overflow-hidden">
                  <Input placeholder="Telebirr phone number" icon={Smartphone} />
                </motion.div>
              )}
            </AnimatePresence>
          </Card>
        </div>

        {/* Order summary */}
        <div>
          <Card className="sticky top-24 p-5">
            <h2 className="mb-4 text-h3 text-fg">Order summary</h2>
            <dl className="space-y-2.5 text-body">
              <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="text-fg">{formatETB(subtotal)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Delivery fee</dt><dd className="text-fg">{formatETB(delivery)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Service fee</dt><dd className="text-success font-semibold">Free</dd></div>
              <div className="flex justify-between border-t border-border pt-3 text-h3 font-bold"><dt className="text-fg">Total</dt><dd className="text-fg">{formatETB(total)}</dd></div>
            </dl>

            <Button className="mt-5 w-full" size="lg" loading={placing} onClick={place}>
              {placing ? 'Processing…' : `Pay ${formatETB(total)}`}
            </Button>

            <div className="mt-4 space-y-2">
              <p className="flex items-center gap-2 text-caption text-muted"><ShieldCheck className="h-4 w-4 text-brand-500" /> Encrypted & PCI-compliant checkout</p>
              <p className="flex items-center gap-2 text-caption text-muted"><Truck className="h-4 w-4 text-brand-500" /> Estimated delivery in 45–60 min</p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
