import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import {
  Search, Upload, Pill, Stethoscope, FlaskConical, HeartPulse, Tags,
  ArrowRight, ShieldCheck, Truck, ChevronRight, ChevronLeft, RefreshCw,
} from 'lucide-react'
import { Button, Card, Input, IconTile, SectionHead, Skeleton } from '../components/ui'
import ProductImage from '../components/ProductImage'
import { Glow } from '../components/PageHero'
import { useCatalog } from '../catalog/catalogService'
import { useSearch } from '../search/searchService'
import { categoryName } from '../catalog/format'
import { CATEGORY_PICTURES, HERO_PICTURES, HOME_SHELVES } from '../catalog/images'
import { ProductCard } from './Medicines'
import { t } from '../auth/strings'

const stagger = { show: { transition: { staggerChildren: 0.06 } } }
const item = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } } }
/** Sections rise into place as they scroll into view. */
const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-60px' },
  transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] },
}

const quickActions = [
  { label: 'home.quick.find', desc: 'home.quick.find.sub', icon: Pill, to: '/search', tone: 'brand' },
  { label: 'home.quick.doctors', desc: 'common.comingLater', icon: Stethoscope, to: '/doctors', tone: 'accent' },
  { label: 'home.quick.lab', desc: 'common.comingLater', icon: FlaskConical, to: '/diagnostics', tone: 'violet' },
  // Work 138: send a prescription to nearby pharmacies; the first to accept offers the medicines.
  { label: 'home.quick.send', desc: 'home.quick.send.sub', icon: Upload, to: '/requests/new', tone: 'success' },
]

const FEATURED_COUNT = 4
const SHELF_SIZE = 10

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

/** Product pictures drifting gently in the hero; still when the viewer prefers reduced motion. */
function HeroCollage() {
  const still = useReducedMotion()
  const spots = [
    { className: 'left-[8%] top-[6%] h-36 w-36 rotate-[-6deg]', delay: 0 },
    { className: 'right-[4%] top-[2%] h-28 w-28 rotate-[8deg]', delay: 0.6 },
    { className: 'left-[30%] top-[34%] h-44 w-44 rotate-[3deg] z-10', delay: 1.2 },
    { className: 'left-[2%] bottom-[4%] h-28 w-28 rotate-[10deg]', delay: 1.8 },
    { className: 'right-[8%] bottom-[8%] h-36 w-36 rotate-[-8deg]', delay: 2.4 },
  ]
  return (
    <div className="relative hidden h-[22rem] lg:block" aria-hidden="true">
      {HERO_PICTURES.map((src, i) => (
        <motion.div
          key={src}
          className={`absolute ${spots[i].className}`}
          initial={{ opacity: 0, scale: 0.85 }}
          animate={still ? { opacity: 1, scale: 1 } : { opacity: 1, scale: 1, y: [0, -12, 0] }}
          transition={{
            opacity: { duration: 0.6, delay: 0.15 * i },
            scale: { duration: 0.6, delay: 0.15 * i },
            y: { duration: 6, repeat: Infinity, ease: 'easeInOut', delay: spots[i].delay },
          }}
        >
          <ProductImage src={src} eager className="h-full w-full rounded-3xl shadow-xl ring-4 ring-white/25" />
        </motion.div>
      ))}
    </div>
  )
}

/** A horizontal row that scrolls with the arrows or a swipe, snapping to each card. */
function ScrollRow({ children, label }) {
  const ref = useRef(null)
  const scroll = (direction) => ref.current?.scrollBy({ left: direction * ref.current.clientWidth * 0.8, behavior: 'smooth' })
  return (
    <div className="group/row relative">
      <div
        ref={ref}
        role="list"
        aria-label={label}
        className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth px-4 pb-2 sm:gap-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      <button
        type="button"
        onClick={() => scroll(-1)}
        aria-label={t('common.previous')}
        className="absolute -left-3 top-[38%] hidden h-10 w-10 place-items-center rounded-full border border-border bg-surface/90 text-fg shadow-md backdrop-blur transition-opacity hover:bg-surface md:grid md:opacity-0 md:group-hover/row:opacity-100"
      >
        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => scroll(1)}
        aria-label={t('common.next')}
        className="absolute -right-3 top-[38%] hidden h-10 w-10 place-items-center rounded-full border border-border bg-surface/90 text-fg shadow-md backdrop-blur transition-opacity hover:bg-surface md:grid md:opacity-0 md:group-hover/row:opacity-100"
      >
        <ChevronRight className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * Work 147: one shelf of the pharmacy, the products of a category with their pictures and lowest
 * price, from search (which knows what is in stock). A shelf with nothing to show stays hidden.
 */
function Shelf({ category }) {
  const search = useSearch()
  const [state, setState] = useState({ status: 'loading', items: [] })
  useEffect(() => {
    const controller = new AbortController()
    search
      .searchMedicines({ categoryId: category.id, size: SHELF_SIZE }, { signal: controller.signal })
      .then((data) => setState({ status: 'ready', items: data.items }))
      .catch((error) => error?.code !== 'ABORTED' && setState({ status: 'error', items: [] }))
    return () => controller.abort()
  }, [search, category.id])

  if (state.status === 'error' || (state.status === 'ready' && state.items.length === 0)) return null
  const name = categoryName(category)
  return (
    <motion.section {...reveal} aria-label={name}>
      <SectionHead
        title={name}
        action={
          <Button as={Link} to={`/medicines?category=${category.id}`} variant="ghost" size="sm">
            {t('home.new.viewAll')} <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        }
      />
      <ScrollRow label={name}>
        {state.status === 'loading'
          ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-72 w-44 shrink-0 rounded-2xl sm:w-52" />)
          : state.items.map((hit) => (
            <div key={hit.productId} role="listitem" className="w-44 shrink-0 snap-start sm:w-52">
              <ProductCard
                product={{ ...hit, id: hit.productId }}
                from="/medicines"
                price={hit.availability?.pharmacyCount > 0 ? hit.availability.minPrice : null}
                currency={hit.availability?.currency}
              />
            </div>
          ))}
      </ScrollRow>
    </motion.section>
  )
}

export default function Home() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const { products, categories } = useHomeCatalog(attempt)
  const retry = (
    <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
      <RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}
    </Button>
  )
  const shelves = HOME_SHELVES.map((slug) => categories.items.find((c) => c.slug === slug)).filter(Boolean)

  return (
    <div className="space-y-12">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[2rem] gradient-brand px-6 py-10 text-white shadow-xl sm:px-10 sm:py-14">
        <Glow />
        <div className="relative grid items-center gap-8 lg:grid-cols-[1.15fr_1fr]">
          <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
            <h1 className="font-display text-display font-extrabold leading-[1.05] tracking-tight sm:text-display-lg">
              {t('home.hero.title')}
            </h1>
            <p className="mt-3 max-w-xl text-body-lg text-white/85">{t('home.hero.body')}</p>

            <form
              role="search"
              onSubmit={(e) => {
                e.preventDefault()
                const q = query.trim()
                navigate(q ? `/search?${new URLSearchParams({ q })}` : '/search')
              }}
              className="mt-6 flex flex-col gap-3 rounded-2xl bg-white/95 p-2.5 shadow-xl ring-1 ring-white/40 transition-shadow focus-within:shadow-2xl sm:flex-row dark:bg-surface"
            >
              <div className="flex flex-1 items-center gap-2">
                <Input
                  icon={Search}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  maxLength={100}
                  placeholder={t('layout.search.placeholder')}
                  aria-label={t('layout.search.label')}
                  className="border-transparent bg-transparent"
                />
              </div>
              <Button type="submit" size="md" className="sm:px-7">{t('home.search')}</Button>
            </form>

            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-caption text-white/85">
              <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> {t('home.badge.licensed')}</span>
              <span className="inline-flex items-center gap-1.5"><Truck className="h-4 w-4" aria-hidden="true" /> {t('home.badge.sameDay')}</span>
            </div>
          </motion.div>
          <HeroCollage />
        </div>
      </section>

      {/* Quick actions */}
      <motion.section variants={stagger} initial="hidden" animate="show" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {quickActions.map((a) => (
          <motion.div key={a.to} variants={item} whileHover={{ y: -4 }}>
            <Card interactive className="group flex h-full flex-col gap-3 p-4 sm:p-5">
              <Link to={a.to} className="flex h-full flex-col gap-3">
                <IconTile icon={a.icon} tone={a.tone} size={48} className="transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-3" />
                <div>
                  <p className="text-body-lg font-semibold text-fg">{t(a.label)}</p>
                  <p className="text-caption text-muted">{t(a.desc)}</p>
                </div>
                <span className="mt-auto inline-flex items-center gap-1 text-caption font-semibold text-brand-600 dark:text-brand-300">
                  {t('home.start')} <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" aria-hidden="true" />
                </span>
              </Link>
            </Card>
          </motion.div>
        ))}
      </motion.section>

      {/* Categories, each with a picture */}
      <motion.section {...reveal}>
        <SectionHead title={t('home.categories.title')} subtitle={t('home.categories.subtitle')} />
        {categories.status === 'loading' && (
          <div role="status" className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <span className="sr-only">{t('common.loadingCategories')}</span>
            {Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="aspect-[4/5] rounded-2xl" />)}
          </div>
        )}
        {categories.status === 'error' && (
          <Card role="alert" className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-body text-muted">{t('home.categories.error')}</p>
            {retry}
          </Card>
        )}
        {categories.status === 'ready' && categories.items.length === 0 && (
          <Card className="p-5"><p className="text-body text-muted">{t('home.categories.empty')}</p></Card>
        )}
        {categories.status === 'ready' && categories.items.length > 0 && (
          <motion.div variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true }} className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {categories.items.map((c) => (
              <motion.div key={c.id} variants={item} whileHover={{ y: -4 }}>
                <Link
                  to={`/medicines?category=${c.id}`}
                  className="group block overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition-shadow hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {CATEGORY_PICTURES[c.slug] ? (
                    <ProductImage src={CATEGORY_PICTURES[c.slug]} zoom className="aspect-square w-full" />
                  ) : (
                    <div className="grid aspect-square w-full place-items-center bg-surface-2"><IconTile icon={Tags} size={44} /></div>
                  )}
                  <span className="block px-2 py-2.5 text-center text-caption font-semibold leading-tight text-fg">{categoryName(c)}</span>
                </Link>
              </motion.div>
            ))}
          </motion.div>
        )}
      </motion.section>

      {/* Shelves of the pharmacy */}
      {shelves.map((c) => <Shelf key={c.id} category={c} />)}

      {/* Prescription upload banner */}
      <motion.section {...reveal}>
        <Card className="relative flex flex-col items-start gap-5 overflow-hidden bg-gradient-to-br from-brand-50 via-surface to-accent-50 p-6 sm:flex-row sm:items-center sm:p-8 dark:from-brand-900/30 dark:via-surface dark:to-accent-700/20">
          <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-brand-500 text-white shadow-lg shadow-brand-500/30">
            <Upload className="h-7 w-7" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <h3 className="text-h3 text-fg">{t('home.rx.title')}</h3>
            <p className="mt-1 text-body text-muted">{t('home.rx.body')}</p>
          </div>
          <Button as={Link} to="/prescriptions" size="md" className="shrink-0">
            <Upload className="h-4 w-4" aria-hidden="true" /> {t('common.uploadPrescription')}
          </Button>
        </Card>
      </motion.section>

      {/* Featured: new in the catalogue */}
      <motion.section {...reveal}>
        <SectionHead
          title={t('home.new.title')}
          subtitle={t('home.new.subtitle')}
          action={<Button as={Link} to="/medicines" variant="ghost" size="sm">{t('home.new.viewAll')} <ChevronRight className="h-4 w-4" aria-hidden="true" /></Button>}
        />
        {products.status === 'loading' && (
          <div role="status" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <span className="sr-only">{t('common.loadingProducts')}</span>
            {Array.from({ length: FEATURED_COUNT }, (_, i) => <Skeleton key={i} className="h-72 rounded-2xl" />)}
          </div>
        )}
        {products.status === 'error' && (
          <Card role="alert" className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-body text-muted">{t('home.new.error')}</p>
            {retry}
          </Card>
        )}
        {products.status === 'ready' && products.items.length === 0 && (
          <Card className="p-5"><p className="text-body text-muted">{t('common.catalogEmpty')}</p></Card>
        )}
        {products.status === 'ready' && products.items.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {products.items.map((p) => <ProductCard key={p.id} product={p} from="/medicines" />)}
          </div>
        )}
      </motion.section>

      {/* Doctors: deferred by the owner (Work 99); no sample profiles. */}
      <motion.section {...reveal}>
        <SectionHead title={t('home.later.title')} subtitle={t('home.later.subtitle')} />
        <Card className="p-5">
          <p className="text-body text-muted">{t('home.later.body')}</p>
        </Card>
      </motion.section>

      {/* Trust strip */}
      <motion.section variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true }} className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: ShieldCheck, title: 'home.trust.verified', desc: 'home.trust.verified.body' },
          { icon: Truck, title: 'home.trust.tracking', desc: 'home.trust.tracking.body' },
          { icon: HeartPulse, title: 'home.trust.private', desc: 'home.trust.private.body' },
        ].map((point) => (
          <motion.div key={point.title} variants={item}>
            <Card className="flex h-full gap-3 p-5">
              <IconTile icon={point.icon} size={44} />
              <div>
                <p className="text-body-lg font-semibold text-fg">{t(point.title)}</p>
                <p className="text-caption text-muted">{t(point.desc)}</p>
              </div>
            </Card>
          </motion.div>
        ))}
      </motion.section>
    </div>
  )
}
