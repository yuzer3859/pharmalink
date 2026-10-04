import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Search, Upload, Pill, Stethoscope, FlaskConical, HeartPulse, Baby, Sparkles,
  MapPin, ArrowRight, ShieldCheck, Truck, Clock, ChevronRight,
} from 'lucide-react'
import { Button, Card, Badge, Input, IconTile, Rating, Avatar, SectionHead } from '../components/ui'
import { medicines, doctors } from '../data/mock'
import { formatETB } from '../lib/utils'

const stagger = { show: { transition: { staggerChildren: 0.06 } } }
const item = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }

const quickActions = [
  { label: 'Order medicine', desc: 'From verified pharmacies', icon: Pill, to: '/medicines', tone: 'brand' },
  { label: 'Book a doctor', desc: 'By specialty & location', icon: Stethoscope, to: '/doctors', tone: 'accent' },
  { label: 'Lab & imaging', desc: 'Tests, scans & screening', icon: FlaskConical, to: '/diagnostics', tone: 'violet' },
  { label: 'Upload Rx', desc: 'We match a pharmacy', icon: Upload, to: '/medicines', tone: 'success' },
]

const cats = [
  { label: 'Prescription', icon: Pill },
  { label: 'Wellness', icon: HeartPulse },
  { label: 'Mother & Baby', icon: Baby },
  { label: 'Personal care', icon: Sparkles },
  { label: 'Devices', icon: Stethoscope },
  { label: 'Lab tests', icon: FlaskConical },
]

export default function Home() {
  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl gradient-brand px-6 py-10 text-white shadow-lg sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-10 h-72 w-72 rounded-full bg-accent-400/20 blur-3xl" />
        <motion.div
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
          className="relative max-w-2xl"
        >
          <Badge className="!bg-white/15 !text-white backdrop-blur" dot>
            Trusted by 40,000+ patients across Ethiopia
          </Badge>
          <h1 className="mt-4 font-display text-display font-extrabold leading-[1.05] tracking-tight sm:text-display-lg">
            Healthcare, delivered with care.
          </h1>
          <p className="mt-3 max-w-xl text-body-lg text-white/85">
            Find medicines, book trusted doctors, and schedule lab tests — all in one secure place.
          </p>

          <div className="mt-6 flex flex-col gap-3 rounded-2xl bg-white/95 p-3 shadow-lg sm:flex-row dark:bg-surface">
            <div className="flex flex-1 items-center gap-2">
              <Input icon={Search} placeholder="Search medicine, doctor, or test…" className="border-transparent bg-transparent" />
            </div>
            <div className="hidden items-center gap-1.5 border-l border-border pl-3 pr-1 text-caption font-semibold text-muted sm:flex">
              <MapPin className="h-4 w-4 text-brand-600" /> Bole, Addis Ababa
            </div>
            <Button as={Link} to="/medicines" size="md" className="sm:px-6">Search</Button>
          </div>

          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-caption text-white/80">
            <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" /> Licensed pharmacies only</span>
            <span className="inline-flex items-center gap-1.5"><Truck className="h-4 w-4" /> Same-day delivery</span>
            <span className="inline-flex items-center gap-1.5"><Clock className="h-4 w-4" /> 24/7 support</span>
          </div>
        </motion.div>
      </section>

      {/* Quick actions */}
      <motion.section variants={stagger} initial="hidden" animate="show"
        className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {quickActions.map((a) => (
          <motion.div key={a.label} variants={item}>
            <Card interactive className="flex h-full flex-col gap-3 p-4 sm:p-5">
              <Link to={a.to} className="flex h-full flex-col gap-3">
                <IconTile icon={a.icon} tone={a.tone} size={48} />
                <div>
                  <p className="text-body-lg font-semibold text-fg">{a.label}</p>
                  <p className="text-caption text-muted">{a.desc}</p>
                </div>
                <span className="mt-auto inline-flex items-center gap-1 text-caption font-semibold text-brand-600 dark:text-brand-300">
                  Start <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            </Card>
          </motion.div>
        ))}
      </motion.section>

      {/* Prescription upload banner */}
      <section>
        <Card className="flex flex-col items-start gap-5 overflow-hidden p-6 sm:flex-row sm:items-center sm:p-7">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand-500/12 text-brand-600 dark:text-brand-300">
            <Upload className="h-7 w-7" />
          </div>
          <div className="flex-1">
            <h3 className="text-h3 text-fg">Have a prescription? Skip the search.</h3>
            <p className="mt-1 text-body text-muted">
              Upload a photo and our system securely matches it to the nearest licensed pharmacy with stock.
            </p>
          </div>
          <Button as={Link} to="/medicines" variant="soft" size="md" className="shrink-0">
            <Upload className="h-4 w-4" /> Upload prescription
          </Button>
        </Card>
      </section>

      {/* Categories */}
      <section>
        <SectionHead title="Shop by category" subtitle="Everything your family needs, in one place." />
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {cats.map((c) => (
            <Card key={c.label} interactive className="flex flex-col items-center gap-2.5 p-4 text-center">
              <IconTile icon={c.icon} size={44} />
              <span className="text-caption font-semibold text-fg">{c.label}</span>
            </Card>
          ))}
        </div>
      </section>

      {/* Featured medicines */}
      <section>
        <SectionHead
          title="Popular right now"
          subtitle="Frequently ordered near you"
          action={<Button as={Link} to="/medicines" variant="ghost" size="sm">View all <ChevronRight className="h-4 w-4" /></Button>}
        />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {medicines.slice(0, 4).map((m) => (
            <Card key={m.id} interactive className="flex flex-col p-4">
              <div className="mb-3 flex items-start justify-between">
                <div className="grid h-16 w-16 place-items-center rounded-2xl bg-surface-2 text-brand-500">
                  <Pill className="h-7 w-7" />
                </div>
                {m.rx ? <Badge tone="warning">Rx</Badge> : <Badge tone="success">OTC</Badge>}
              </div>
              <p className="line-clamp-1 text-body-lg font-semibold text-fg">{m.name}</p>
              <p className="text-caption text-muted">{m.form}</p>
              <div className="mt-1"><Rating value={m.rating} count={m.reviews} /></div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-h3 font-bold text-fg">{formatETB(m.price)}</span>
                <Button size="sm">Add</Button>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* Top doctors */}
      <section>
        <SectionHead
          title="Top-rated doctors"
          subtitle="Verified specialists accepting appointments"
          action={<Button as={Link} to="/doctors" variant="ghost" size="sm">View all <ChevronRight className="h-4 w-4" /></Button>}
        />
        <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
          {doctors.slice(0, 2).map((d) => (
            <Card key={d.id} interactive className="flex items-center gap-4 p-4">
              <Avatar name={d.name} size={64} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-body-lg font-semibold text-fg">{d.name}</p>
                  {d.verified && <ShieldCheck className="h-4 w-4 shrink-0 text-brand-500" />}
                </div>
                <p className="text-caption text-muted">{d.specialty} · {d.hospital}</p>
                <div className="mt-1.5 flex items-center gap-3">
                  <Rating value={d.rating} count={d.reviews} />
                  <Badge tone="success" dot>{d.next}</Badge>
                </div>
              </div>
              <Button as={Link} to="/doctors" variant="soft" size="sm" className="shrink-0">Book</Button>
            </Card>
          ))}
        </div>
      </section>

      {/* Trust strip */}
      <section className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: ShieldCheck, title: 'Verified & licensed', desc: 'Every pharmacy and doctor is credential-checked.' },
          { icon: Truck, title: 'Real-time tracking', desc: 'Follow your delivery partner live on the map.' },
          { icon: HeartPulse, title: 'Private by design', desc: 'Medical data encrypted end-to-end with Fayda ID.' },
        ].map((t) => (
          <Card key={t.title} className="flex gap-3 p-5">
            <IconTile icon={t.icon} size={44} />
            <div>
              <p className="text-body-lg font-semibold text-fg">{t.title}</p>
              <p className="text-caption text-muted">{t.desc}</p>
            </div>
          </Card>
        ))}
      </section>
    </div>
  )
}
