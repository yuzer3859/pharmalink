import { useState } from 'react'
import { CheckCircle2, LogOut, ShieldAlert, UserRound, XCircle } from 'lucide-react'
import { Badge, Button, Card } from '../../components/ui'
import { useAuth } from '../../auth/AuthContext'
import { t } from '../../auth/strings'

function formatDate(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(date)
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-caption font-semibold text-muted">{label}</dt>
      <dd className="text-body text-fg sm:text-right">{children}</dd>
    </div>
  )
}

/**
 * Shows only what `GET /users/me` returned. The API exposes no creation date or name, so neither is
 * shown. E-mail verification and Fayda identity are separate: one never implies the other.
 */
export default function Account() {
  const { user, logout } = useAuth()
  const [leaving, setLeaving] = useState(false)
  const verifiedOn = formatDate(user.emailVerifiedAt)
  const statusLabel = t(`account.status.${user.status}`)

  async function onLogout() {
    setLeaving(true)
    await logout()
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-500/12 text-brand-600 dark:text-brand-300">
          <UserRound className="h-6 w-6" aria-hidden="true" />
        </span>
        <div>
          <h1 className="font-display text-h1 text-fg">{t('account.title')}</h1>
          <p className="text-body text-muted">{t('account.subtitle')}</p>
        </div>
      </div>

      <Card className="px-5 sm:px-6">
        <dl className="divide-y divide-border">
          <Row label={t('account.email')}>{user.email ?? t('account.notProvided')}</Row>
          <Row label={t('account.emailStatus')}>
            {user.emailVerifiedAt ? (
              <Badge tone="success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                {verifiedOn ? t('account.emailVerifiedOn', { date: verifiedOn }) : t('account.emailVerified')}
              </Badge>
            ) : (
              <Badge tone="warning"><XCircle className="h-3.5 w-3.5" aria-hidden="true" /> {t('account.emailUnverified')}</Badge>
            )}
          </Row>
          {user.phone && (
            <Row label={t('account.phone')}>
              {user.phone}
              {!user.phoneVerifiedAt && <span className="block text-caption text-subtle">{t('account.phoneUnverified')}</span>}
            </Row>
          )}
          <Row label={t('account.status')}>
            {statusLabel.startsWith('account.status.') ? user.status : statusLabel}
          </Row>
          <Row label={t('account.language')}>
            {user.preferredLanguage === 'am' ? t('language.am') : user.preferredLanguage === 'en' ? t('language.en') : user.preferredLanguage}
          </Row>
        </dl>
      </Card>

      <Card className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
          <div>
            <p className="text-body font-semibold text-fg">{t('account.fayda')}</p>
            <p className="mt-1 text-body text-muted">{t('account.faydaNotConnected')}</p>
            <p className="mt-1 text-caption text-subtle">{t('account.faydaNote')}</p>
          </div>
        </div>
      </Card>

      {user.deletionRequestedAt && <p className="text-caption text-warning">{t('account.deletionPending')}</p>}

      <Button variant="secondary" onClick={onLogout} loading={leaving} disabled={leaving}>
        <LogOut className="h-4 w-4" aria-hidden="true" /> {t('account.logout')}
      </Button>
    </div>
  )
}
