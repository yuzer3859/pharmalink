import { forwardRef } from 'react'
import { Star, Check, Loader2 } from 'lucide-react'
import { cn } from '../lib/utils'

/* ---------------------------------- Button --------------------------------- */
const buttonVariants = {
  primary:
    'gradient-brand text-white shadow-sm hover:shadow-md hover:brightness-[1.03] active:brightness-95',
  secondary:
    'bg-surface text-fg border border-border hover:bg-surface-2 shadow-xs',
  soft: 'bg-brand-500/10 text-brand-700 dark:text-brand-300 hover:bg-brand-500/15',
  ghost: 'text-fg hover:bg-surface-2',
  outline: 'border border-border text-fg hover:bg-surface-2',
  danger: 'bg-danger text-white hover:brightness-105 shadow-sm',
}
const buttonSizes = {
  sm: 'h-9 px-3.5 text-caption gap-1.5 rounded-lg',
  md: 'h-11 px-5 text-body gap-2 rounded-xl',
  lg: 'px-7 py-3.5 text-body-lg gap-2.5 rounded-xl',
  icon: 'h-11 w-11 rounded-xl',
}

export const Button = forwardRef(function Button(
  { as: Comp = 'button', variant = 'primary', size = 'md', className, loading, children, ...props },
  ref,
) {
  return (
    <Comp
      ref={ref}
      className={cn(
        'inline-flex select-none items-center justify-center font-semibold transition-all duration-200',
        'focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </Comp>
  )
})

/* ----------------------------------- Card ---------------------------------- */
export function Card({ className, interactive, children, ...props }) {
  return (
    <div
      className={cn(
        'card',
        interactive &&
          'transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg cursor-pointer',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/* ---------------------------------- Badge ---------------------------------- */
const badgeTones = {
  brand: 'bg-brand-500/12 text-brand-700 dark:text-brand-300',
  neutral: 'bg-surface-2 text-muted',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/12 text-danger',
  info: 'bg-info/12 text-info',
}
export function Badge({ tone = 'neutral', className, children, dot }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption font-semibold',
        badgeTones[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/* ---------------------------------- Input ---------------------------------- */
export const Input = forwardRef(function Input({ className, icon: Icon, ...props }, ref) {
  return (
    <div className="relative w-full">
      {Icon && (
        <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-subtle" />
      )}
      <input
        ref={ref}
        className={cn(
          'h-11 w-full rounded-xl border border-border bg-surface text-body text-fg placeholder:text-subtle',
          'transition-shadow focus:border-brand-500 focus:shadow-glow focus-visible:outline-none',
          Icon ? 'pl-10 pr-4' : 'px-4',
          className,
        )}
        {...props}
      />
    </div>
  )
})

/* --------------------------------- Avatar ---------------------------------- */
export function Avatar({ name = '', src, size = 40, className, ring }) {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <div
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-500/15 font-semibold text-brand-700 dark:text-brand-300',
        ring && 'ring-2 ring-surface',
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {src ? <img src={src} alt={name} className="h-full w-full object-cover" /> : initials}
    </div>
  )
}

/* --------------------------------- Rating ---------------------------------- */
export function Rating({ value = 0, count, size = 14, className }) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <Star className="fill-warning text-warning" style={{ width: size, height: size }} />
      <span className="text-caption font-semibold text-fg">{value.toFixed(1)}</span>
      {count != null && <span className="text-caption text-subtle">({count})</span>}
    </span>
  )
}

/* -------------------------------- IconTile --------------------------------- */
export function IconTile({ icon: Icon, tone = 'brand', size = 44, className }) {
  const tones = {
    brand: 'bg-brand-500/12 text-brand-600 dark:text-brand-300',
    accent: 'bg-accent-500/12 text-accent-600 dark:text-accent-300',
    success: 'bg-success/12 text-success',
    warning: 'bg-warning/15 text-warning',
    danger: 'bg-danger/12 text-danger',
    violet: 'bg-violet-500/12 text-violet-500',
  }
  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-xl', tones[tone], className)}
      style={{ width: size, height: size }}
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  )
}

/* ------------------------------- Segmented --------------------------------- */
export function Segmented({ options, value, onChange, className }) {
  return (
    <div className={cn('inline-flex rounded-xl bg-surface-2 p-1', className)}>
      {options.map((opt) => {
        const val = opt.value ?? opt
        const label = opt.label ?? opt
        const active = val === value
        return (
          <button
            key={val}
            onClick={() => onChange(val)}
            className={cn(
              'relative rounded-lg px-3.5 py-1.5 text-caption font-semibold transition-colors',
              active ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------- Checklist --------------------------------- */
export function CheckItem({ children, className }) {
  return (
    <li className={cn('flex items-start gap-2.5 text-body text-muted', className)}>
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      {children}
    </li>
  )
}

/* -------------------------------- Skeleton --------------------------------- */
export function Skeleton({ className }) {
  return <div className={cn('skeleton', className)} />
}

/* ------------------------------- SectionHead ------------------------------- */
export function SectionHead({ title, subtitle, action }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-h2 font-display text-fg">{title}</h2>
        {subtitle && <p className="mt-1 text-body text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
