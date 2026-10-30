import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { KeyRound } from 'lucide-react'
import { Button } from '../../components/ui'
import { Alert, AuthShell, EmailField, OtpField, PasswordField, PasswordRules } from '../../components/auth'
import { RedirectIfSignedIn, useAuth } from '../../auth/AuthContext'
import { describeAuthError, passwordRequirements } from '../../auth/errors'
import { t } from '../../auth/strings'
import { validateConfirmation, validateEmail, validateOtp, validatePassword } from '../../auth/validation'

const linkCls = 'font-semibold text-brand-600 hover:underline dark:text-brand-300'

/** The backend resets the password and returns no session, so the customer signs in afterwards. */
export default function ResetPassword() {
  const { resetPassword } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState(typeof location.state?.email === 'string' ? location.state.email : '')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState({})
  const [failure, setFailure] = useState(null)
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event) {
    event.preventDefault()
    if (submitting) return
    const next = {
      email: validateEmail(email),
      code: validateOtp(code),
      password: validatePassword(password),
      confirm: validateConfirmation(password, confirm),
    }
    setErrors(next)
    setFailure(null)
    if (Object.values(next).some(Boolean)) return
    setSubmitting(true)
    try {
      await resetPassword({ email: email.trim(), code, newPassword: password })
      setDone(true)
    } catch (error) {
      setFailure(error)
      setCode('')
    } finally {
      setSubmitting(false)
    }
  }

  const requirements = passwordRequirements(failure)

  return (
    <RedirectIfSignedIn>
      <AuthShell
        icon={KeyRound}
        title={t('reset.title')}
        subtitle={done ? undefined : t('reset.subtitle')}
        footer={
          done ? null : (
            <p>
              {t('reset.needCode')} <Link to="/forgot-password" className={linkCls}>{t('forgot.submit')}</Link>
            </p>
          )
        }
      >
        {done ? (
          <div className="space-y-4">
            <Alert tone="success"><p>{t('reset.done')}</p></Alert>
            <Button as={Link} to="/login" className="w-full">{t('common.signIn')}</Button>
          </div>
        ) : (
          <form noValidate onSubmit={onSubmit} className="space-y-4" aria-busy={submitting}>
            {failure && (
              <Alert tone="error">
                <p>{describeAuthError(failure)}</p>
                {requirements.length > 0 && (
                  <ul className="list-disc pl-4">{requirements.map((r) => <li key={r}>{r}</li>)}</ul>
                )}
              </Alert>
            )}
            <EmailField value={email} onChange={setEmail} error={errors.email} autoFocus={!email} />
            <OtpField value={code} onChange={setCode} error={errors.code} />
            <PasswordField
              label={t('field.newPassword')}
              value={password}
              onChange={setPassword}
              error={errors.password}
              autoComplete="new-password"
            />
            <PasswordRules password={password} />
            <PasswordField
              label={t('field.confirmNewPassword')}
              value={confirm}
              onChange={setConfirm}
              error={errors.confirm}
              autoComplete="new-password"
            />
            <Button type="submit" className="w-full" loading={submitting} disabled={submitting}>
              {submitting ? t('common.working') : t('reset.submit')}
            </Button>
          </form>
        )}
      </AuthShell>
    </RedirectIfSignedIn>
  )
}
