import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { Button } from '../../components/ui'
import { Alert, AuthShell, EmailField, Field, PasswordField, PasswordRules } from '../../components/auth'
import { RedirectIfSignedIn, useAuth } from '../../auth/AuthContext'
import { describeAuthError, passwordRequirements } from '../../auth/errors'
import { t } from '../../auth/strings'
import { validateConfirmation, validateEmail, validatePassword } from '../../auth/validation'

export default function Register() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [language, setLanguage] = useState('en')
  const [errors, setErrors] = useState({})
  const [failure, setFailure] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event) {
    event.preventDefault()
    if (submitting) return
    const next = {
      email: validateEmail(email),
      password: validatePassword(password),
      confirm: validateConfirmation(password, confirm),
    }
    setErrors(next)
    setFailure(null)
    if (Object.values(next).some(Boolean)) return

    setSubmitting(true)
    try {
      const normalized = email.trim()
      const result = await register({ email: normalized, password, preferredLanguage: language })
      // The address travels in router state, never in the URL.
      navigate('/verify-email', { state: { email: normalized, target: result.verification.target } })
    } catch (error) {
      setFailure(error)
      setSubmitting(false)
    }
  }

  const requirements = passwordRequirements(failure)

  return (
    <RedirectIfSignedIn>
      <AuthShell
        icon={UserPlus}
        title={t('register.title')}
        subtitle={t('register.subtitle')}
        footer={
          <p>
            {t('register.haveAccount')}{' '}
            <Link to="/login" className="font-semibold text-brand-600 hover:underline dark:text-brand-300">{t('common.signIn')}</Link>
          </p>
        }
      >
        <form noValidate onSubmit={onSubmit} className="space-y-4" aria-busy={submitting}>
          {failure && (
            <Alert tone="error">
              <p>{describeAuthError(failure)}</p>
              {requirements.length > 0 && (
                <ul className="list-disc pl-4">{requirements.map((r) => <li key={r}>{r}</li>)}</ul>
              )}
            </Alert>
          )}
          <EmailField value={email} onChange={setEmail} error={errors.email} autoFocus />
          <PasswordField value={password} onChange={setPassword} error={errors.password} autoComplete="new-password" />
          <PasswordRules password={password} />
          <PasswordField
            label={t('field.confirmPassword')}
            value={confirm}
            onChange={setConfirm}
            error={errors.confirm}
            autoComplete="new-password"
          />
          <Field label={t('field.language')}>
            {(props) => (
              <select
                {...props}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="h-11 w-full rounded-xl border border-border bg-surface px-4 text-body text-fg focus:border-brand-500 focus:shadow-glow focus-visible:outline-none"
              >
                <option value="en">{t('language.en')}</option>
                <option value="am">{t('language.am')}</option>
              </select>
            )}
          </Field>
          <p className="text-caption text-subtle">{t('register.smsNote')}</p>
          <Button type="submit" className="w-full" loading={submitting} disabled={submitting}>
            {submitting ? t('common.working') : t('register.submit')}
          </Button>
        </form>
      </AuthShell>
    </RedirectIfSignedIn>
  )
}
