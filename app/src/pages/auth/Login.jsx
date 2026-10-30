import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { Button } from '../../components/ui'
import { Alert, AuthShell, EmailField, PasswordField } from '../../components/auth'
import { RedirectIfSignedIn, safeDestination, useAuth } from '../../auth/AuthContext'
import { describeAuthError } from '../../auth/errors'
import { t } from '../../auth/strings'
import { validateEmail } from '../../auth/validation'

const linkCls = 'font-semibold text-brand-600 hover:underline dark:text-brand-300'

export default function Login() {
  const { login, expired } = useAuth()
  const location = useLocation()
  const destination = safeDestination(location.state?.from)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState({})
  const [failure, setFailure] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event) {
    event.preventDefault()
    if (submitting) return
    const next = { email: validateEmail(email), password: password ? null : t('validation.password.required') }
    setErrors(next)
    setFailure(null)
    if (next.email || next.password) return
    setSubmitting(true)
    try {
      // On success <RedirectIfSignedIn> sends the customer on to `destination`.
      await login({ email: email.trim(), password })
    } catch (error) {
      setFailure(error)
      setPassword('')
      setSubmitting(false)
    }
  }

  return (
    <RedirectIfSignedIn to={destination}>
      <AuthShell
        icon={LogIn}
        title={t('login.title')}
        subtitle={t('login.subtitle')}
        footer={
          <>
            <p>
              {t('login.noAccount')} <Link to="/register" className={linkCls}>{t('common.createAccount')}</Link>
            </p>
            <p className="text-caption text-subtle">{t('login.staffNote')}</p>
          </>
        }
      >
        <form noValidate onSubmit={onSubmit} className="space-y-4" aria-busy={submitting}>
          {expired && !failure && <Alert tone="info"><p>{t('login.expired')}</p></Alert>}
          {failure && (
            <Alert tone="error">
              <p>{describeAuthError(failure)}</p>
              {failure.code === 'AUTH_INVALID_CREDENTIALS' && (
                <p><Link to="/verify-email" className="underline">{t('login.unverified')}</Link></p>
              )}
            </Alert>
          )}
          <EmailField value={email} onChange={setEmail} error={errors.email} autoFocus />
          <PasswordField value={password} onChange={setPassword} error={errors.password} />
          <div className="text-right">
            <Link to="/forgot-password" className={`text-caption ${linkCls}`}>{t('login.forgot')}</Link>
          </div>
          <Button type="submit" className="w-full" loading={submitting} disabled={submitting}>
            {submitting ? t('common.working') : t('login.submit')}
          </Button>
        </form>
      </AuthShell>
    </RedirectIfSignedIn>
  )
}
