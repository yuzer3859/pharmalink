import { useState } from 'react'
import { Link } from 'react-router-dom'
import { KeyRound } from 'lucide-react'
import { Button } from '../../components/ui'
import { Alert, AuthShell, EmailField } from '../../components/auth'
import { RedirectIfSignedIn, useAuth } from '../../auth/AuthContext'
import { describeAuthError } from '../../auth/errors'
import { t } from '../../auth/strings'
import { validateEmail } from '../../auth/validation'

const linkCls = 'font-semibold text-brand-600 hover:underline dark:text-brand-300'

/**
 * The backend answers the same way whether or not the address has an account, so this page shows one
 * generic message on success. The only error it shows for a valid address is "e-mail is not set up on
 * this server" (checked before any account lookup), a rate limit or a network failure.
 */
export default function ForgotPassword() {
  const { forgotPassword } = useAuth()
  const [email, setEmail] = useState('')
  const [error, setError] = useState(null)
  const [failure, setFailure] = useState(null)
  const [sentTo, setSentTo] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event) {
    event.preventDefault()
    if (submitting) return
    const emailError = validateEmail(email)
    setError(emailError)
    setFailure(null)
    if (emailError) return
    setSubmitting(true)
    try {
      await forgotPassword(email.trim())
      setSentTo(email.trim())
    } catch (err) {
      setFailure(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <RedirectIfSignedIn>
      <AuthShell
        icon={KeyRound}
        title={t('forgot.title')}
        subtitle={t('forgot.subtitle')}
        footer={<p><Link to="/login" className={linkCls}>{t('verify.backToLogin')}</Link></p>}
      >
        {sentTo ? (
          <div className="space-y-4">
            <Alert tone="success"><p>{t('forgot.done')}</p></Alert>
            <Button as={Link} to="/reset-password" state={{ email: sentTo }} className="w-full">
              {t('forgot.haveCode')}
            </Button>
          </div>
        ) : (
          <form noValidate onSubmit={onSubmit} className="space-y-4" aria-busy={submitting}>
            {failure && <Alert tone="error"><p>{describeAuthError(failure)}</p></Alert>}
            <EmailField value={email} onChange={setEmail} error={error} autoFocus />
            <Button type="submit" className="w-full" loading={submitting} disabled={submitting}>
              {submitting ? t('common.working') : t('forgot.submit')}
            </Button>
            <p className="text-center text-caption">
              <Link to="/reset-password" className={linkCls}>{t('forgot.haveCode')}</Link>
            </p>
          </form>
        )}
      </AuthShell>
    </RedirectIfSignedIn>
  )
}
