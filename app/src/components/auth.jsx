import { useId, useState } from 'react'
import { AlertCircle, CheckCircle2, Eye, EyeOff, Info, Mail, Lock } from 'lucide-react'
import { Card, Input } from './ui'
import { cn } from '../lib/utils'
import { t } from '../auth/strings'
import { PASSWORD_RULES, normalizeOtp } from '../auth/validation'

/* Building blocks for the customer authentication pages, on the prototype's existing tokens. */

export function AuthShell({ icon: Icon = Lock, title, subtitle, children, footer }) {
  return (
    <div className="mx-auto w-full max-w-md py-6 sm:py-10">
      <Card className="p-6 sm:p-8">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-500/12 text-brand-600 dark:text-brand-300">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </span>
        <h1 className="mt-4 font-display text-h2 text-fg">{title}</h1>
        {subtitle && <p className="mt-1.5 text-body text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </Card>
      {footer && <div className="mt-5 space-y-2 text-center text-body text-muted">{footer}</div>}
    </div>
  )
}

const alertTones = {
  error: { cls: 'border-danger/30 bg-danger/10 text-danger', icon: AlertCircle },
  success: { cls: 'border-success/30 bg-success/10 text-success', icon: CheckCircle2 },
  info: { cls: 'border-border bg-surface-2 text-muted', icon: Info },
}

/** Errors are announced assertively, other notices politely. */
export function Alert({ tone = 'info', children, className }) {
  const { cls, icon: Icon } = alertTones[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      className={cn('flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-caption font-medium', cls, className)}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="space-y-1">{children}</div>
    </div>
  )
}

export function Field({ label, error, hint, children }) {
  const id = useId()
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-caption font-semibold text-fg">{label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {hint && <p id={`${id}-hint`} className="text-caption text-subtle">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-caption font-medium text-danger">{error}</p>}
    </div>
  )
}

export function EmailField({ value, onChange, error, autoFocus }) {
  return (
    <Field label={t('field.email')} error={error}>
      {(props) => (
        <Input
          {...props}
          icon={Mail}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={error ? 'border-danger' : undefined}
        />
      )}
    </Field>
  )
}

export function PasswordField({ label = t('field.password'), value, onChange, error, autoComplete = 'current-password', hint }) {
  const [visible, setVisible] = useState(false)
  return (
    <Field label={label} error={error} hint={hint}>
      {(props) => (
        <div className="relative">
          <Input
            {...props}
            icon={Lock}
            type={visible ? 'text' : 'password'}
            autoComplete={autoComplete}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn('pr-12', error && 'border-danger')}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? t('field.hidePassword') : t('field.showPassword')}
            aria-pressed={visible}
            className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-subtle hover:bg-surface-2 hover:text-fg"
          >
            {visible ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
          </button>
        </div>
      )}
    </Field>
  )
}

/** One field for the whole code: numeric keypad on phones, one-time-code autofill, paste-friendly. */
export function OtpField({ value, onChange, error }) {
  return (
    <Field label={t('field.code')} error={error}>
      {(props) => (
        <Input
          {...props}
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          placeholder="••••••"
          value={value}
          onChange={(e) => onChange(normalizeOtp(e.target.value))}
          onPaste={(e) => {
            e.preventDefault()
            onChange(normalizeOtp(e.clipboardData.getData('text')))
          }}
          className={cn('text-center font-display text-h3 tracking-[0.5em]', error && 'border-danger')}
        />
      )}
    </Field>
  )
}

export function PasswordRules({ password }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3.5 py-3">
      <p className="text-caption font-semibold text-fg">{t('password.rules')}</p>
      <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
        {PASSWORD_RULES.map((rule) => {
          const met = rule.test(password)
          return (
            <li key={rule.key} className={cn('flex items-center gap-1.5 text-caption', met ? 'text-success' : 'text-subtle')}>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t(rule.key)}</span>
              <span className="sr-only">{met ? '(met)' : '(not met)'}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
