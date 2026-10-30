import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MailCheck } from 'lucide-react'
import { Button } from '../../components/ui'
import { Alert, AuthShell, EmailField, OtpField } from '../../components/auth'
import { RedirectIfSignedIn, useAuth } from '../../auth/AuthContext'
import { describeAuthError, retryAfterSeconds } from '../../auth/errors'
import { t } from '../../auth/strings'
import { useCountdown } from '../../auth/useCountdown'
import { validateEmail, validateOtp } from '../../auth/validation'

export default function VerifyEmail() {
  const { verifyRegistration, resendRegistrationCode } = useAuth()
  const location = useLocation()
  const fromRegistration = typeof location.state?.email === 'string' ? location.state : null
  const [email, setEmail] = useState(fromRegistration?.email ?? '')
  const [code, setCode] = useState('')
  const [errors, setErrors] = useState({})
  const [failure, setFailure] = useState(null)
  const [notice, setNotice] = useState(null)
  const [verifying, setVerifying] = useState(false)
  const [resending, setResending] = useState(false)
  const [cooldown, startCooldown] = useCountdown()

  function checkEmail() {
    const emailError = fromRegistration ? null : validateEmail(email)
    return emailError
  }

  async function onVerify(event) {
    event.preventDefault()
    if (verifying) return
    const next = { email: checkEmail(), code: validateOtp(code) }
    setErrors(next)
    setFailure(null)
    setNotice(null)
    if (next.email || next.code) return
    setVerifying(true)
    try {
      // On success the session starts and <RedirectIfSignedIn> takes the customer to their account.
      await verifyRegistration({ email: email.trim(), code })
    } catch (error) {
      setFailure(error)
      setCode('')
      setVerifying(false)
    }
  }

  async function onResend() {
    if (resending || cooldown > 0) return
    const emailError = checkEmail()
    setErrors({ email: emailError })
    setFailure(null)
    setNotice(null)
    if (emailError) return
    setResending(true)
    try {
      const { cooldownSeconds } = await resendRegistrationCode(email.trim())
      setNotice(t('verify.resent'))
      startCooldown(cooldownSeconds)
    } catch (error) {
      setFailure(error)
      startCooldown(retryAfterSeconds(error) ?? 0)
    } finally {
      setResending(false)
    }
  }

  return (
    <RedirectIfSignedIn>
      <AuthShell
        icon={MailCheck}
        title={t('verify.title')}
        subtitle={fromRegistration?.target ? t('verify.sentTo', { target: fromRegistration.target }) : t('verify.sentGeneric')}
        footer={
          <p className="flex flex-wrap justify-center gap-x-4 gap-y-1">
            <Link to="/register" className="font-semibold text-brand-600 hover:underline dark:text-brand-300">{t('verify.backToRegister')}</Link>
            <Link to="/login" className="font-semibold text-brand-600 hover:underline dark:text-brand-300">{t('verify.backToLogin')}</Link>
          </p>
        }
      >
        <form noValidate onSubmit={onVerify} className="space-y-4" aria-busy={verifying}>
          {failure && <Alert tone="error"><p>{describeAuthError(failure)}</p></Alert>}
          {notice && <Alert tone="success"><p>{notice}</p></Alert>}
          {!fromRegistration && <EmailField value={email} onChange={setEmail} error={errors.email} autoFocus />}
          <OtpField value={code} onChange={setCode} error={errors.code} />
          <p className="text-caption text-subtle">{t('verify.expiry')} {t('verify.noCode')}</p>
          <Button type="submit" className="w-full" loading={verifying} disabled={verifying}>
            {verifying ? t('common.working') : t('verify.submit')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={onResend}
            loading={resending}
            disabled={resending || cooldown > 0}
          >
            {cooldown > 0 ? t('verify.resendIn', { seconds: cooldown }) : t('verify.resend')}
          </Button>
        </form>
      </AuthShell>
    </RedirectIfSignedIn>
  )
}
