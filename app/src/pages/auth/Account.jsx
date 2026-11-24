import { useState } from 'react'
import { CheckCircle2, LogOut, ShieldAlert, UserRound, XCircle } from 'lucide-react'
import { Badge, Button, Card } from '../../components/ui'
import { useAuth } from '../../auth/AuthContext'
import { t } from '../../auth/strings'
import { PageHero, StaggerItem, StaggerList } from '../../components/PageHero'
import { PAGE_PICTURES } from '../../catalog/images'

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

/** Work 130: the customer chooses English or Amharic and saves it to their account. */
function LanguageChoice({ current }) {
  const { updateLanguage } = useAuth()
  const [choice, setChoice] = useState(current === 'am' ? 'am' : 'en')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const changed = choice !== current

  async function onSave() {
    setSaving(true)
    setMessage(null)
    try {
      await updateLanguage(choice)
      setMessage({ tone: 'ok', text: t('account.languageSaved') })
    } catch {
      setMessage({ tone: 'error', text: t('account.languageFailed') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div className="flex items-center gap-2">
        <select
          id="account-language"
          aria-label={t('account.language')}
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value)
            setMessage(null)
          }}
          className="h-10 rounded-xl border border-border bg-surface px-3 text-body text-fg focus:border-brand-500 focus:shadow-glow focus-visible:outline-none"
        >
          <option value="en">{t('language.en')}</option>
          <option value="am">{t('language.am')}</option>
        </select>
        <Button variant="secondary" onClick={onSave} loading={saving} disabled={saving || !changed}>
          {saving ? t('common.working') : t('account.languageSave')}
        </Button>
      </div>
      {message && (
        <span role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'text-caption text-danger' : 'text-caption text-success'}>
          {message.text}
        </span>
      )}
      <span className="text-caption text-subtle sm:max-w-xs">{t('account.languageNote')}</span>
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
    <StaggerList className="mx-auto max-w-2xl space-y-5">
      <PageHero icon={UserRound} title={t('account.title')} subtitle={t('account.subtitle')} pictures={PAGE_PICTURES.account} />

      <StaggerItem>
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
            <LanguageChoice current={user.preferredLanguage} />
          </Row>
        </dl>
      </Card>
      </StaggerItem>

      <StaggerItem>
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
      </StaggerItem>

      {user.deletionRequestedAt && <p className="text-caption text-warning">{t('account.deletionPending')}</p>}

      <Button variant="secondary" onClick={onLogout} loading={leaving} disabled={leaving}>
        <LogOut className="h-4 w-4" aria-hidden="true" /> {t('account.logout')}
      </Button>
    </StaggerList>
  )
}
