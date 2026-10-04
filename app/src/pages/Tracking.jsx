import { motion } from 'framer-motion'
import { Phone, MessageSquare, Star, MapPin, Truck, Navigation, ShieldCheck, Package } from 'lucide-react'
import { Button, Card, Badge, Avatar } from '../components/ui'
import { trackingSteps } from '../data/mock'

function MapMock() {
  return (
    <div className="relative h-64 w-full overflow-hidden rounded-3xl border border-border sm:h-80">
      {/* stylised map */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,#c7f0e8,transparent_45%),radial-gradient(circle_at_80%_70%,#dbeafe,transparent_45%)] dark:bg-[radial-gradient(circle_at_30%_20%,#0f3d38,transparent_45%),radial-gradient(circle_at_80%_70%,#132a52,transparent_45%)]" />
      <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
        <defs>
          <pattern id="grid" width="44" height="44" patternUnits="userSpaceOnUse">
            <path d="M44 0H0V44" fill="none" stroke="currentColor" strokeWidth="1" className="text-border" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" opacity="0.5" />
        <path d="M40 40 C 160 120, 220 60, 340 200" fill="none" stroke="#14b8a6" strokeWidth="4" strokeLinecap="round" strokeDasharray="2 12" />
      </svg>

      {/* origin */}
      <div className="absolute left-8 top-8 flex flex-col items-center">
        <div className="grid h-9 w-9 place-items-center rounded-full bg-surface shadow-md">
          <Package className="h-4 w-4 text-brand-600" />
        </div>
      </div>
      {/* courier moving */}
      <motion.div
        className="absolute"
        initial={{ left: '20%', top: '35%' }}
        animate={{ left: ['20%', '55%', '62%'], top: ['35%', '25%', '55%'] }}
        transition={{ duration: 6, repeat: Infinity, repeatType: 'reverse', ease: 'easeInOut' }}
      >
        <span className="relative flex">
          <span className="absolute inline-flex h-11 w-11 -translate-x-1/4 -translate-y-1/4 animate-pulse-ring rounded-full bg-brand-500/40" />
          <span className="relative grid h-10 w-10 place-items-center rounded-full gradient-brand text-white shadow-lg">
            <Truck className="h-5 w-5" />
          </span>
        </span>
      </motion.div>
      {/* destination */}
      <div className="absolute bottom-10 right-10">
        <div className="grid h-9 w-9 place-items-center rounded-full bg-danger text-white shadow-md">
          <MapPin className="h-4 w-4" />
        </div>
      </div>

      <div className="absolute bottom-3 left-3 glass rounded-xl px-3 py-2 text-caption font-semibold text-fg shadow-sm">
        <span className="text-brand-600 dark:text-brand-300">Arriving in ~14 min</span> · 3.2 km away
      </div>
    </div>
  )
}

export default function Tracking() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-h1 text-fg">Track your order</h1>
          <p className="text-body text-muted">Order <span className="font-semibold text-fg">#PL-48213</span> · Bole Pharma</p>
        </div>
        <Badge tone="success" dot>Out for delivery</Badge>
      </div>

      <MapMock />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Timeline */}
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-4 text-h3 text-fg">Delivery progress</h2>
          <ol className="relative space-y-6">
            {trackingSteps.map((s, i) => (
              <li key={s.id} className="relative flex gap-4 pl-1">
                {i < trackingSteps.length - 1 && (
                  <span className={'absolute left-[13px] top-7 h-[calc(100%+0.5rem)] w-0.5 ' + (s.done ? 'bg-brand-500' : 'bg-border')} />
                )}
                <span className={
                  'relative z-10 mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ' +
                  (s.done ? 'bg-brand-500 text-white'
                    : s.active ? 'bg-brand-500/15 text-brand-600 ring-2 ring-brand-500' : 'bg-surface-2 text-subtle')
                }>
                  {s.done ? <ShieldCheck className="h-4 w-4" /> : <span className={'h-2 w-2 rounded-full ' + (s.active ? 'bg-brand-500' : 'bg-subtle')} />}
                </span>
                <div className="flex-1 pb-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className={'text-body font-semibold ' + (s.done || s.active ? 'text-fg' : 'text-subtle')}>{s.title}</p>
                    <span className="text-caption text-subtle">{s.time}</span>
                  </div>
                  <p className="text-caption text-muted">{s.desc}</p>
                  {s.active && (
                    <motion.div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
                      <motion.div className="h-full gradient-brand"
                        initial={{ width: '10%' }} animate={{ width: '65%' }} transition={{ duration: 1.2, ease: 'easeOut' }} />
                    </motion.div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Card>

        {/* Courier + summary */}
        <div className="space-y-5">
          <Card className="p-5">
            <p className="text-caption font-semibold uppercase tracking-wide text-subtle">Your delivery partner</p>
            <div className="mt-3 flex items-center gap-3">
              <Avatar name="Dawit Solomon" size={52} />
              <div className="flex-1">
                <p className="text-body-lg font-semibold text-fg">Dawit Solomon</p>
                <span className="inline-flex items-center gap-1 text-caption text-muted">
                  <Star className="h-3.5 w-3.5 fill-warning text-warning" /> 4.9 · Motorbike
                </span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button variant="secondary" size="sm"><Phone className="h-4 w-4" /> Call</Button>
              <Button variant="secondary" size="sm"><MessageSquare className="h-4 w-4" /> Chat</Button>
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 p-3 text-caption text-muted">
              <Navigation className="h-4 w-4 text-brand-600" /> Delivering to Bole, Rwanda St, Bldg 4
            </div>
          </Card>

          <Card className="p-5">
            <p className="text-caption font-semibold uppercase tracking-wide text-subtle">Order summary</p>
            <ul className="mt-3 space-y-2 text-body">
              <li className="flex justify-between"><span className="text-muted">Paracetamol 500mg ×2</span><span className="text-fg">ETB 120</span></li>
              <li className="flex justify-between"><span className="text-muted">ORS Sachets ×1</span><span className="text-fg">ETB 95</span></li>
              <li className="flex justify-between"><span className="text-muted">Delivery</span><span className="text-fg">ETB 60</span></li>
              <li className="flex justify-between border-t border-border pt-2 font-semibold"><span className="text-fg">Total</span><span className="text-fg">ETB 275</span></li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}
