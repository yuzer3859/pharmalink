import { NavLink, Link, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Home, Pill, Stethoscope, FlaskConical, Truck, Palette,
  Search, Bell, Moon, Sun, ShoppingBag, Menu, X, ShieldCheck,
} from 'lucide-react'
import { useState } from 'react'
import { useTheme } from '../lib/theme'
import { cn } from '../lib/utils'
import { Avatar, Input } from './ui'

const nav = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/medicines', label: 'Medicines', icon: Pill },
  { to: '/doctors', label: 'Doctors', icon: Stethoscope },
  { to: '/diagnostics', label: 'Diagnostics', icon: FlaskConical },
  { to: '/tracking', label: 'Track order', icon: Truck },
  { to: '/design-system', label: 'Design system', icon: Palette },
]

function Logo({ compact }) {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-xl gradient-brand text-white shadow-sm">
        <span className="relative flex h-4 w-4 items-center justify-center">
          <span className="absolute h-4 w-[3px] rounded-full bg-white" />
          <span className="absolute h-[3px] w-4 rounded-full bg-white" />
        </span>
      </span>
      {!compact && (
        <span className="font-display text-h3 font-extrabold tracking-tight text-fg">
          Pharma<span className="text-gradient">Link</span>
        </span>
      )}
    </Link>
  )
}

function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-border bg-surface lg:flex">
      <div className="flex h-16 items-center px-6">
        <Logo />
      </div>
      <nav className="flex-1 space-y-1 px-3 py-2">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-body font-semibold transition-colors',
                isActive ? 'bg-brand-500/12 text-brand-700 dark:text-brand-300' : 'text-muted hover:bg-surface-2 hover:text-fg',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span layoutId="nav-active" className="absolute left-0 h-6 w-1 rounded-r-full bg-brand-500" />
                )}
                <Icon className="h-5 w-5" />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="m-3 rounded-2xl border border-border bg-surface-2 p-4">
        <div className="flex items-center gap-2 text-brand-600 dark:text-brand-300">
          <ShieldCheck className="h-5 w-5" />
          <span className="text-caption font-semibold">Fayda ID verified</span>
        </div>
        <p className="mt-2 text-caption leading-relaxed text-muted">
          Your medical data is encrypted and shared only with licensed providers.
        </p>
      </div>
    </aside>
  )
}

function Topbar({ onMenu }) {
  const { theme, toggle } = useTheme()
  return (
    <header className="sticky top-0 z-30 h-16 border-b border-border glass">
      <div className="flex h-full items-center gap-3 px-4 sm:px-6 lg:pl-8 lg:pr-8">
        <button
          onClick={onMenu}
          className="grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface-2 lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="lg:hidden"><Logo compact /></div>

        <div className="mx-auto hidden w-full max-w-xl md:block">
          <Input icon={Search} placeholder="Search medicines, doctors, tests, pharmacies…" aria-label="Search" />
        </div>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <button
            onClick={toggle}
            className="grid h-10 w-10 place-items-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            aria-label="Toggle dark mode"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={theme}
                initial={{ rotate: -90, opacity: 0 }}
                animate={{ rotate: 0, opacity: 1 }}
                exit={{ rotate: 90, opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </motion.span>
            </AnimatePresence>
          </button>
          <button className="relative grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg" aria-label="Notifications">
            <Bell className="h-5 w-5" />
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-danger ring-2 ring-surface" />
          </button>
          <Link to="/checkout" className="relative grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg" aria-label="Cart">
            <ShoppingBag className="h-5 w-5" />
            <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-brand-500 px-1 text-[10px] font-bold text-white">3</span>
          </Link>
          <button className="ml-1 rounded-full focus-visible:outline-none" aria-label="Account">
            <Avatar name="Meron A" size={36} ring />
          </button>
        </div>
      </div>
    </header>
  )
}

function MobileNav() {
  const items = nav.slice(0, 5)
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border glass pb-[env(safe-area-inset-bottom)] lg:hidden">
      <div className="grid grid-cols-5">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition-colors',
                isActive ? 'text-brand-600 dark:text-brand-300' : 'text-subtle',
              )
            }
          >
            <Icon className="h-5 w-5" />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}

function MobileDrawer({ open, onClose }) {
  const loc = useLocation()
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-50 bg-slate-900/50 lg:hidden"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed inset-y-0 left-0 z-50 w-[280px] bg-surface p-4 lg:hidden"
            initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          >
            <div className="flex items-center justify-between px-2 py-2">
              <Logo />
              <button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface-2" aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="mt-4 space-y-1">
              {nav.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to} to={to} end={to === '/'} onClick={onClose}
                  className={cn(
                    'flex items-center gap-3 rounded-xl px-3 py-3 text-body font-semibold',
                    loc.pathname === to ? 'bg-brand-500/12 text-brand-700 dark:text-brand-300' : 'text-muted hover:bg-surface-2',
                  )}
                >
                  <Icon className="h-5 w-5" /> {label}
                </NavLink>
              ))}
            </nav>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

export default function Layout({ children }) {
  const [drawer, setDrawer] = useState(false)
  return (
    <div className="min-h-screen">
      <Sidebar />
      <MobileDrawer open={drawer} onClose={() => setDrawer(false)} />
      <div className="lg:pl-[248px]">
        <Topbar onMenu={() => setDrawer(true)} />
        <main className="container-app py-6 pb-28 sm:py-8 lg:pb-12">{children}</main>
      </div>
      <MobileNav />
    </div>
  )
}
