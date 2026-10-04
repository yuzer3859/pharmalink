import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, ShieldCheck, MapPin, Languages, Clock, CalendarDays,
  Video, Building2, X, Check, Star,
} from 'lucide-react'
import { Button, Card, Badge, Input, Rating, Avatar } from '../components/ui'
import { doctors } from '../data/mock'
import { formatETB } from '../lib/utils'

const specialties = ['All', 'Cardiologist', 'Dermatologist', 'Pediatrician', 'General Physician']
const days = [
  { d: 'Mon', n: 14 }, { d: 'Tue', n: 15 }, { d: 'Wed', n: 16 },
  { d: 'Thu', n: 17 }, { d: 'Fri', n: 18 }, { d: 'Sat', n: 19 },
]
const slots = ['09:00', '09:30', '10:00', '11:30', '14:00', '15:30', '16:00', '17:00']

function BookingSheet({ doctor, onClose }) {
  const [day, setDay] = useState(2)
  const [slot, setSlot] = useState('10:00')
  const [mode, setMode] = useState('clinic')
  const [confirmed, setConfirmed] = useState(false)

  return (
    <AnimatePresence>
      <motion.div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-surface p-5 shadow-xl sm:inset-y-0 sm:right-0 sm:left-auto sm:rounded-t-none sm:rounded-l-3xl"
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 32, stiffness: 320 }}
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-border sm:hidden" />
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Avatar name={doctor.name} size={56} />
            <div>
              <p className="text-body-lg font-semibold text-fg">{doctor.name}</p>
              <p className="text-caption text-muted">{doctor.specialty} · {doctor.hospital}</p>
            </div>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl text-muted hover:bg-surface-2" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {confirmed ? (
          <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="py-10 text-center">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-success/15 text-success">
              <Check className="h-8 w-8" strokeWidth={3} />
            </div>
            <h3 className="mt-4 text-h2 font-display text-fg">Appointment confirmed</h3>
            <p className="mt-1 text-body text-muted">
              {days[day].d} {days[day].n} at {slot} · {mode === 'clinic' ? 'In-person' : 'Video call'}
            </p>
            <p className="mt-1 text-caption text-subtle">A reminder will be sent 1 hour before.</p>
            <Button className="mt-6 w-full" onClick={onClose}>Done</Button>
          </motion.div>
        ) : (
          <>
            <div className="mt-5 grid grid-cols-2 gap-2">
              {[{ id: 'clinic', label: 'In-person', icon: Building2 }, { id: 'video', label: 'Video call', icon: Video }].map((m) => (
                <button key={m.id} onClick={() => setMode(m.id)}
                  className={'flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-body font-semibold transition-colors ' +
                    (mode === m.id ? 'border-brand-500 bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'border-border text-muted')}>
                  <m.icon className="h-4 w-4" /> {m.label}
                </button>
              ))}
            </div>

            <p className="mt-5 text-caption font-semibold text-muted">Select a date · March 2025</p>
            <div className="mt-2 grid grid-cols-6 gap-2">
              {days.map((d, i) => (
                <button key={d.n} onClick={() => setDay(i)}
                  className={'flex flex-col items-center rounded-xl border py-2 transition-colors ' +
                    (day === i ? 'border-brand-500 bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'border-border text-muted hover:text-fg')}>
                  <span className="text-[11px] font-semibold">{d.d}</span>
                  <span className="text-body-lg font-bold">{d.n}</span>
                </button>
              ))}
            </div>

            <p className="mt-5 text-caption font-semibold text-muted">Available times</p>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {slots.map((s) => (
                <button key={s} onClick={() => setSlot(s)}
                  className={'rounded-xl border py-2.5 text-caption font-semibold transition-colors ' +
                    (slot === s ? 'border-brand-500 bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'border-border text-muted hover:text-fg')}>
                  {s}
                </button>
              ))}
            </div>

            <div className="mt-5 flex items-center justify-between rounded-2xl bg-surface-2 p-4">
              <span className="text-body text-muted">Consultation fee</span>
              <span className="text-h3 font-bold text-fg">{formatETB(doctor.fee)}</span>
            </div>
            <Button className="mt-4 w-full" size="lg" onClick={() => setConfirmed(true)}>
              Confirm appointment
            </Button>
            <p className="mt-2 text-center text-caption text-subtle">Free cancellation up to 2 hours before.</p>
          </>
        )}
      </motion.div>
    </AnimatePresence>
  )
}

export default function Doctors() {
  const [spec, setSpec] = useState('All')
  const [active, setActive] = useState(null)
  const list = doctors.filter((d) => spec === 'All' || d.specialty === spec)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-h1 text-fg">Find a doctor</h1>
        <p className="text-body text-muted">Verified specialists from participating hospitals & clinics.</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input icon={Search} placeholder="Search by name, specialty, or hospital…" />
        <Button variant="secondary" size="md" className="shrink-0"><MapPin className="h-4 w-4" /> Near me</Button>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {specialties.map((s) => (
          <button key={s} onClick={() => setSpec(s)}
            className={'whitespace-nowrap rounded-full border px-3.5 py-1.5 text-caption font-semibold transition-colors ' +
              (spec === s ? 'border-brand-500 bg-brand-500/12 text-brand-700 dark:text-brand-300' : 'border-border bg-surface text-muted hover:text-fg')}>
            {s}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
        {list.map((d) => (
          <motion.div key={d.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="flex flex-col gap-4 p-5">
              <div className="flex items-start gap-4">
                <div className="relative">
                  <Avatar name={d.name} size={72} />
                  <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full bg-brand-500 text-white ring-2 ring-surface">
                    <ShieldCheck className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-body-lg font-semibold text-fg">{d.name}</p>
                  <p className="text-caption text-muted">{d.specialty}</p>
                  <div className="mt-1 flex items-center gap-1 text-caption text-muted">
                    <Building2 className="h-3.5 w-3.5" /> {d.hospital}
                  </div>
                </div>
                <div className="text-right">
                  <Rating value={d.rating} count={d.reviews} />
                  <p className="mt-1 text-caption text-subtle">{d.experience} yrs exp.</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Badge tone="neutral"><Languages className="h-3.5 w-3.5" /> {d.langs.join(', ')}</Badge>
                <Badge tone="success" dot><Clock className="h-3.5 w-3.5" /> {d.next}</Badge>
              </div>

              <div className="flex items-center justify-between border-t border-border pt-4">
                <div>
                  <span className="text-caption text-muted">From </span>
                  <span className="text-h3 font-bold text-fg">{formatETB(d.fee)}</span>
                </div>
                <Button size="md" onClick={() => setActive(d)}>
                  <CalendarDays className="h-4 w-4" /> Book appointment
                </Button>
              </div>
            </Card>
          </motion.div>
        ))}
      </div>

      {active && <BookingSheet doctor={active} onClose={() => setActive(null)} />}
    </div>
  )
}
