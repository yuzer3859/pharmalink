import { motion, useReducedMotion } from 'framer-motion'
import ProductImage from './ProductImage'
import { HERO_PICTURES } from '../catalog/images'
import { cn } from '../lib/utils'

const EASE = [0.22, 1, 0.36, 1]

/** Soft blobs of light that breathe behind a gradient band; still for reduced motion. */
export function Glow() {
  const still = useReducedMotion()
  const breathe = (delay) => (still ? {} : { animate: { scale: [1, 1.15, 1], opacity: [0.5, 0.8, 0.5] }, transition: { duration: 9, repeat: Infinity, ease: 'easeInOut', delay } })
  return (
    <>
      <motion.div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-24 h-80 w-80 rounded-full bg-white/15 blur-3xl" {...breathe(0)} />
      <motion.div aria-hidden="true" className="pointer-events-none absolute -bottom-28 -left-16 h-96 w-96 rounded-full bg-accent-400/30 blur-3xl" {...breathe(3)} />
      <motion.div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/3 h-64 w-64 rounded-full bg-brand-300/20 blur-3xl" {...breathe(6)} />
    </>
  )
}

/** Three product pictures floating at the band's right edge (decorative, from sm up). */
function Floaters({ pictures }) {
  const still = useReducedMotion()
  const spots = ['right-[16%] top-3 h-20 w-20 rotate-[-6deg]', 'right-3 top-10 h-24 w-24 rotate-[8deg]', 'right-[30%] -bottom-3 h-16 w-16 rotate-[10deg]']
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-80 sm:block" aria-hidden="true">
      {pictures.slice(0, 3).map((src, i) => (
        <motion.div
          key={src}
          className={cn('absolute', spots[i])}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={still ? { opacity: 1, scale: 1 } : { opacity: 1, scale: 1, y: [0, -8, 0] }}
          transition={{ opacity: { duration: 0.5, delay: 0.1 * i }, scale: { duration: 0.5, delay: 0.1 * i }, y: { duration: 6, repeat: Infinity, ease: 'easeInOut', delay: 0.8 * i } }}
        >
          <ProductImage src={src} eager className="h-full w-full rounded-2xl shadow-xl ring-4 ring-white/25" />
        </motion.div>
      ))}
    </div>
  )
}

/**
 * Work 152: the customer pages' header — the home hero's gradient band, glow and floating product
 * pictures, in a compact form. `title` is the page's h1; `children` sit under it (badges, actions).
 */
export function PageHero({ icon: Icon, title, subtitle, pictures = HERO_PICTURES, children, className }) {
  return (
    <section className={cn('relative overflow-hidden rounded-[2rem] gradient-brand px-6 py-7 text-white shadow-xl sm:px-8 sm:py-9', className)}>
      <Glow />
      {pictures.length > 0 && <Floaters pictures={pictures} />}
      <motion.div className="relative flex items-start gap-4 sm:max-w-[60%]" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
        {Icon && (
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white/20 ring-1 ring-white/30 backdrop-blur">
            <Icon className="h-6 w-6" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0">
          <h1 className="font-display text-h1 font-extrabold leading-tight tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-body text-white/85">{subtitle}</p>}
          {children && <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>}
        </div>
      </motion.div>
    </section>
  )
}

const list = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const entry = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } } }

/** A list whose items rise in one after another. */
export function StaggerList({ className, children, ...props }) {
  return (
    <motion.div variants={list} initial="hidden" animate="show" className={className} {...props}>
      {children}
    </motion.div>
  )
}

export function StaggerItem({ children, className, lift = false }) {
  return (
    <motion.div variants={entry} whileHover={lift ? { y: -3 } : undefined} className={className}>
      {children}
    </motion.div>
  )
}
