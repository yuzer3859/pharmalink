import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Search, Upload, Pill, Stethoscope, FlaskConical, HeartPulse, Tags,
  ArrowRight, ShieldCheck, Truck, Clock, ChevronRight, RefreshCw,
} from 'lucide-react'
import { Button, Card, Badge, Input, IconTile, Rating, Avatar, SectionHead, Skeleton } from '../components/ui'
import { doctors } from '../data/mock'
import { useCatalog } from '../catalog/catalogService'
import { categoryName } from '../catalog/format'
import { ProductCard } from './Medicines'

const stagger = { show: { transition: { staggerChildren: 0.06 } } }
const item = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }

const quickActions = [
  { label: 'Order medicine', desc: 'From verified pharmacies', icon: Pill, to: '/medicines', tone: 'brand' },
  { label: 'Book a doctor', desc: 'By specialty & location', icon: Stethoscope, to: '/doctors', tone: 'accent' },
  { label: 'Lab & imaging', desc: 'Tests, scans & screening', icon: FlaskConical, to: '/diagnostics', tone: 'violet' },
  { label: 'Upload Rx', desc: 'Coming soon', icon: Upload, to: '/medicines', tone: 'success' },
]

const FEATURED_COUNT = 4

/** Featured products and top-level categories, straight from the Catalog API (no fallback data). */
function useHomeCatalog(attempt) {
  const catalog = useCatalog()
  const [products, setProducts] = useState({ status: 'loading', items: [] })
  const [categories, setCategories] = useState({ status: 'loading', items: [] })
  useEffect(() => {
    const controller = new AbortController()
    setProducts({ status: 'loading', items: [] })
    setCategories({ status: 'loading', items: [] })
    catalog
      .searchProducts({ sort: 'newest', size: FEATURED_COUNT }, { signal: controller.signal })
      .then((data) => setProducts({ status: 'ready', items: data.items }))
      .catch((error) => error?.code !== 'ABORTED' && setProducts({ status: 'error', items: [] }))
    catalog
      .getCategoryTree({ signal: controller.signal })
      .then((tree) => setCategories({ status: 'ready', items: tree.filter((c) => c.isActive !== false) }))
      .catch((error) => error?.code !== 'ABORTED' && setCategories({ status: 'error', items: [] }))
    return () => controller.abort()
  }, [catalog, attempt])
  return { products, categories }
}

export default function Home() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const { products, categories } = useHomeCatalog(attempt)
  const retry = (
    <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
      <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
    </Button>
  )

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

          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault()
              const q = query.trim()
              navigate(q ? `/medicines?${new URLSearchParams({ q })}` : '/medicines')
            }}
            className="mt-6 flex flex-col gap-3 rounded-2xl bg-white/95 p-3 shadow-lg sm:flex-row dark:bg-surface"
          >
            <div className="flex flex-1 items-center gap-2">
              <Input
                icon={Search}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                maxLength={100}
                placeholder="Search medicines and health products…"
                aria-label="Search medicines and health products"
                className="border-transparent bg-transparent"
              />
            </div>
            <Button type="submit" size="md" className="sm:px-6">Search</Button>
          </form>

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
            <h3 className="text-h3 text-fg">Have a prescription? Upload is coming soon.</h3>
            <p className="mt-1 text-body text-muted">
              Prescription upload and pharmacist review are not available yet. You can already browse the catalog.
            </p>
          </div>
          <Button as={Link} to="/medicines" variant="soft" size="md" className="shrink-0">
            <Pill className="h-4 w-4" /> Browse medicines
          </Button>
        </Card>
      </section>

      {/* Categories */}
      <section>
        <SectionHead title="Shop by category" subtitle="Categories from the PharmaLink catalog." />
        {categories.status === 'loading' && (
          <div role="status" className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            <span className="sr-only">Loading categories…</span>
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
          </div>
        )}
        {categories.status === 'error' && (
          <Card role="alert" className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-body text-muted">Categories could not be loaded.</p>
            {retry}
          </Card>
        )}
        {categories.status === 'ready' && categories.items.length === 0 && (
          <Card className="p-5"><p className="text-body text-muted">No categories have been set up in the catalog yet.</p></Card>
        )}
        {categories.status === 'ready' && categories.items.length > 0 && (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {categories.items.slice(0, 6).map((c) => (
              <Card key={c.id} interactive>
                <Link to={`/medicines?category=${c.id}`} className="flex h-full flex-col items-center gap-2.5 rounded-2xl p-4 text-center">
                  <IconTile icon={Tags} size={44} />
                  <span className="text-caption font-semibold text-fg">{categoryName(c)}</span>
                </Link>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Featured medicines */}
      <section>
        <SectionHead
          title="New in the catalog"
          subtitle="Recently added medicines and health products"
          action={<Button as={Link} to="/medicines" variant="ghost" size="sm">View all <ChevronRight className="h-4 w-4" /></Button>}
        />
        {products.status === 'loading' && (
          <div role="status" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <span className="sr-only">Loading products…</span>
            {Array.from({ length: FEATURED_COUNT }, (_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
          </div>
        )}
        {products.status === 'error' && (
          <Card role="alert" className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-body text-muted">Products could not be loaded from the catalog.</p>
            {retry}
          </Card>
        )}
        {products.status === 'ready' && products.items.length === 0 && (
          <Card className="p-5"><p className="text-body text-muted">The catalog has no products yet.</p></Card>
        )}
        {products.status === 'ready' && products.items.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {products.items.map((p) => <ProductCard key={p.id} product={p} from="/medicines" />)}
          </div>
        )}
      </section>

      {/* Top doctors */}
      <section>
        <SectionHead
          title="Doctors"
          subtitle="Sample profiles: doctor booking is a design prototype and not connected yet."
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
          { icon: HeartPulse, title: 'Private by design', desc: 'Medical data protected. Fayda ID verification is planned and not yet connected.' },
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
