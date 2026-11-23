import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Home, Pill, Stethoscope, FlaskConical, Truck, Palette,
  Search, Bell, Moon, Sun, ShoppingBag, Menu, X, ShieldAlert, Upload,
  LogIn, LogOut, UserPlus, UserRound, Send,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from '../lib/theme'
import { cn } from '../lib/utils'
import { useAuth } from '../auth/AuthContext'
import { t, useLanguage } from '../auth/strings'
import { useOrders } from '../pages/Checkout'
import { cartItemCount, onCartChanged } from '../lib/cartEvents'
import CartDrawer from './CartDrawer'
import { Avatar, Button, Input, Skeleton } from './ui'

const nav = [
  { to: '/', labelKey: 'layout.nav.home', icon: Home },
  { to: '/medicines', labelKey: 'layout.nav.medicines', icon: Pill },
  { to: '/prescriptions', labelKey: 'layout.nav.prescriptions', icon: Upload },
  { to: '/requests', labelKey: 'layout.nav.requests', icon: Send },
  { to: '/doctors', labelKey: 'layout.nav.doctors', icon: Stethoscope },
  { to: '/diagnostics', labelKey: 'layout.nav.diagnostics', icon: FlaskConical },
  { to: '/orders', labelKey: 'layout.nav.orders', icon: Truck },
  // The design system page is for the team and stays in English.
  { to: '/design-system', label: 'Design system', icon: Palette },
]

const navLabel = (item) => (item.labelKey ? t(item.labelKey) : item.label)

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
        {nav.map(({ to, icon: Icon, ...item }) => (
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
                {navLabel(item)}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="m-3 rounded-2xl border border-border bg-surface-2 p-4">
        <div className="flex items-center gap-2 text-muted">
          <ShieldAlert className="h-5 w-5" />
          <span className="text-caption font-semibold">{t('layout.fayda.title')}</span>
        </div>
        <p className="mt-2 text-caption leading-relaxed text-muted">
          {t('layout.fayda.body')}
        </p>
      </div>
    </aside>
  )
}

/** The signed-in customer's display name: their e-mail address, as the API returns no name. */
export function customerLabel(user) {
  return user?.email ?? user?.phone ?? ''
}

function AccountMenu() {
  const { status, user, logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (status === 'initializing') {
    return (
      <span role="status" className="ml-1 inline-flex">
        <Skeleton className="h-9 w-9 rounded-full" />
        <span className="sr-only">{t('nav.loadingSession')}</span>
      </span>
    )
  }

  if (status !== 'signedIn') {
    return (
      <div className="ml-1 flex items-center gap-1.5">
        <Button as={Link} to="/login" variant="ghost" size="sm" className="whitespace-nowrap">
          <LogIn className="h-4 w-4" aria-hidden="true" /> {t('nav.login')}
        </Button>
        <Button as={Link} to="/register" size="sm" className="hidden whitespace-nowrap sm:inline-flex">
          {t('nav.register')}
        </Button>
      </div>
    )
  }

  const label = customerLabel(user)
  return (
    <div ref={ref} className="relative ml-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        aria-label={t('nav.accountMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar name={label} size={36} ring />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-50 w-64 rounded-2xl border border-border bg-surface p-2 shadow-lg">
          <p className="truncate px-3 py-2 text-caption text-muted" title={label}>{label}</p>
          <Link
            role="menuitem"
            to="/account"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-body font-semibold text-fg hover:bg-surface-2"
          >
            <UserRound className="h-4 w-4" aria-hidden="true" /> {t('nav.account')}
          </Link>
          <button
            role="menuitem"
            onClick={async () => {
              setOpen(false)
              await logout()
              navigate('/')
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-body font-semibold text-fg hover:bg-surface-2"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" /> {t('nav.logout')}
          </button>
        </div>
      )}
    </div>
  )
}

/** Header search: goes to the live medicine catalog search. */
function HeaderSearch() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        const q = query.trim()
        navigate(q ? `/search?${new URLSearchParams({ q })}` : '/search')
      }}
    >
      <Input
        icon={Search}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        maxLength={100}
        placeholder={t('layout.search.placeholder')}
        aria-label={t('layout.search.label')}
      />
    </form>
  )
}

/**
 * Work 147: how many items are in the signed-in customer's cart, read again when the page changes
 * or the cart changes; 0 when signed out or when it can't be read. Checkout reads the cart itself
 * and reports the count, so on that page the top bar doesn't read it a second time.
 */
function useCartCount() {
  const { status } = useAuth()
  const orders = useOrders()
  const location = useLocation()
  const [count, setCount] = useState(0)
  const [version, setVersion] = useState(0)
  useEffect(
    () => onCartChanged((known) => (Number.isInteger(known) ? setCount(known) : setVersion((v) => v + 1))),
    [],
  )
  useEffect(() => {
    if (status !== 'signedIn') {
      setCount(0)
      return undefined
    }
    if (location.pathname === '/checkout') return undefined
    let active = true
    orders
      .cart()
      .then((cart) => active && setCount(cartItemCount(cart)))
      .catch(() => active && setCount(0))
    return () => {
      active = false
    }
  }, [status, orders, location.pathname, version])
  return count
}

function Topbar({ onMenu }) {
  const { theme, toggle } = useTheme()
  const cartCount = useCartCount()
  const { status } = useAuth()
  const location = useLocation()
  const [cartOpen, setCartOpen] = useState(false)
  const closeCart = useCallback(() => setCartOpen(false), [])
  // Work 148: a signed-in customer's cart slides in; on checkout, or signed out, the icon is a link.
  const drawer = status === 'signedIn' && location.pathname !== '/checkout'
  const cartClass = 'relative grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg'
  const cartIcon = (
    <>
      <ShoppingBag className="h-5 w-5" />
      <AnimatePresence>
        {cartCount > 0 && (
          <motion.span
            key={cartCount}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 18 }}
            data-testid="cart-count"
            className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-brand-500 px-1 text-[10px] font-bold text-white"
          >
            {cartCount > 99 ? '99+' : cartCount}
          </motion.span>
        )}
      </AnimatePresence>
    </>
  )
  return (
    <header className="sticky top-0 z-30 h-16 border-b border-border glass">
      <div className="flex h-full items-center gap-3 px-4 sm:px-6 lg:pl-8 lg:pr-8">
        <button
          onClick={onMenu}
          className="grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface-2 lg:hidden"
          aria-label={t('layout.openMenu')}
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="lg:hidden"><Logo compact /></div>

        <div className="mx-auto hidden w-full max-w-xl md:block">
          <HeaderSearch />
        </div>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <button
            onClick={toggle}
            className="grid h-10 w-10 place-items-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            aria-label={t('layout.darkMode')}
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
          <button className="relative grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg" aria-label={t('layout.notifications')}>
            <Bell className="h-5 w-5" />
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-danger ring-2 ring-surface" />
          </button>
          {drawer ? (
            <button type="button" onClick={() => setCartOpen(true)} className={cartClass} aria-label={t('layout.cart')} aria-haspopup="dialog" aria-expanded={cartOpen}>
              {cartIcon}
            </button>
          ) : (
            <Link to="/checkout" className={cartClass} aria-label={t('layout.cart')}>
              {cartIcon}
            </Link>
          )}
          <AccountMenu />
        </div>
      </div>
      {drawer && <CartDrawer open={cartOpen} onClose={closeCart} />}
    </header>
  )
}

function MobileNav() {
  const items = nav.slice(0, 5)
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border glass pb-[env(safe-area-inset-bottom)] lg:hidden">
      <div className="grid grid-cols-5">
        {items.map(({ to, icon: Icon, ...item }) => (
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
            {navLabel(item)}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}

function DrawerAccount({ onClose }) {
  const { status, user, logout } = useAuth()
  const navigate = useNavigate()
  const item = 'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-body font-semibold text-muted hover:bg-surface-2'
  if (status === 'initializing') return null
  if (status !== 'signedIn') {
    return (
      <>
        <Link to="/login" onClick={onClose} className={item}><LogIn className="h-5 w-5" /> {t('nav.login')}</Link>
        <Link to="/register" onClick={onClose} className={item}><UserPlus className="h-5 w-5" /> {t('nav.register')}</Link>
      </>
    )
  }
  return (
    <>
      <p className="truncate px-3 pb-1 text-caption text-subtle">{customerLabel(user)}</p>
      <Link to="/account" onClick={onClose} className={item}><UserRound className="h-5 w-5" /> {t('nav.account')}</Link>
      <button
        onClick={async () => {
          onClose()
          await logout()
          navigate('/')
        }}
        className={item}
      >
        <LogOut className="h-5 w-5" /> {t('nav.logout')}
      </button>
    </>
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
              <button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface-2" aria-label={t('layout.closeMenu')}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="mt-4 space-y-1">
              {nav.map(({ to, icon: Icon, ...item }) => (
                <NavLink
                  key={to} to={to} end={to === '/'} onClick={onClose}
                  className={cn(
                    'flex items-center gap-3 rounded-xl px-3 py-3 text-body font-semibold',
                    loc.pathname === to ? 'bg-brand-500/12 text-brand-700 dark:text-brand-300' : 'text-muted hover:bg-surface-2',
                  )}
                >
                  <Icon className="h-5 w-5" /> {navLabel(item)}
                </NavLink>
              ))}
            </nav>
            <div className="mt-4 space-y-1 border-t border-border pt-4">
              <DrawerAccount onClose={onClose} />
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

export default function Layout({ children }) {
  const [drawer, setDrawer] = useState(false)
  // Work 143: the menu and top bar draw again in the new language.
  useLanguage()
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
