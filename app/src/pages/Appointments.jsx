import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { CalendarCheck, MapPin, Video, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, Segmented, Skeleton } from '../components/ui'
import { PageHero, StaggerItem, StaggerList } from '../components/PageHero'
import { PAGE_PICTURES } from '../catalog/images'
import { formatMinorUnits } from '../lib/utils'
import { localDayLabel, localTime, useAppointments, appointmentError } from '../doctors/doctorsService'
import { t, useLanguage } from '../auth/strings'

const TONES = { CONFIRMED: 'success', CHECKED_IN: 'info', IN_PROGRESS: 'info', COMPLETED: 'neutral', CANCELLED: 'danger', NO_SHOW: 'warning' }

/**
 * Work 171: the customer's doctor appointments (Work 168) — upcoming and past — with Cancel (an
 * optional reason, asked once) and Move (another time with the same doctor) up to 2 hours before.
 * The fee is paid at the visit.
 */
export default function Appointments() {
  const appointments = useAppointments()
  const language = useLanguage()
  const { state } = useLocation()
  const [scope, setScope] = useState('upcoming')
  const [list, setList] = useState({ status: 'loading', items: [] })
  const [cancelling, setCancelling] = useState(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const [notice, setNotice] = useState(state?.notice ?? null)

  const load = useCallback(() => {
    setList((l) => ({ ...l, status: 'loading' }))
    appointments
      .mine(scope)
      .then((items) => setList({ status: 'ready', items }))
      .catch(() => setList({ status: 'error', items: [] }))
  }, [appointments, scope])
  useEffect(load, [load])

  async function cancel() {
    setBusy(true)
    setProblem(null)
    try {
      await appointments.cancel(cancelling.appointmentId, reason)
      setCancelling(null)
      setReason('')
      setNotice('cancelled')
      load()
    } catch (error) {
      setProblem(appointmentError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHero icon={CalendarCheck} title={t('appointments.title')} subtitle={t('appointments.subtitle')} pictures={PAGE_PICTURES.doctors} />
      {notice && <p role="status" className="rounded-2xl bg-success/12 px-4 py-3 text-body text-success">{t(`appointments.notice.${notice}`)}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented options={[{ value: 'upcoming', label: t('appointments.upcoming') }, { value: 'past', label: t('appointments.past') }]} value={scope} onChange={setScope} />
        <Button as={Link} to="/doctors" variant="secondary" size="sm">{t('appointments.bookAnother')}</Button>
      </div>

      {list.status === 'loading' && <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-28" />)}</div>}
      {list.status === 'error' && (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <p className="text-body text-fg">{t('search.unavailable')}</p>
          <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}</Button>
        </Card>
      )}
      {list.status === 'ready' && list.items.length === 0 && (
        <Card className="p-8 text-center text-body text-fg">{t(scope === 'upcoming' ? 'appointments.noneUpcoming' : 'appointments.nonePast')}</Card>
      )}
      <StaggerList className="space-y-3">
        {list.items.map((a) => (
          <StaggerItem key={a.appointmentId}>
            <Card className="space-y-2 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-body-lg font-semibold text-fg">{localDayLabel(a.startsAt, language)}, {localTime(a.startsAt)}</p>
                <Badge tone={TONES[a.status] ?? 'neutral'}>{t(`appointments.status.${a.status}`)}</Badge>
              </div>
              <p className="text-body text-fg">
                <Link to={`/doctors/${a.doctor.doctorId}`} className="font-semibold text-brand-600">{a.doctor.fullName}</Link>
                {a.doctor.specialty ? ` · ${a.doctor.specialty}` : ''}
              </p>
              <p className="flex items-center gap-1 text-caption text-muted">
                {a.appointmentType === 'TELEMEDICINE' ? <Video className="h-3.5 w-3.5" aria-hidden="true" /> : <MapPin className="h-3.5 w-3.5" aria-hidden="true" />}
                {a.appointmentType === 'TELEMEDICINE' ? t('doctors.video') : [a.location?.name, a.location?.providerName, a.location?.city].filter(Boolean).join(', ')}
              </p>
              {a.fee !== null && <p className="text-caption text-muted">{t('doctors.feeAtVisit', { fee: formatMinorUnits(a.fee, a.currency) })}</p>}
              {a.canChange && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button as={Link} to={`/doctors/${a.doctor.doctorId}?reschedule=${a.appointmentId}`} variant="secondary" size="sm">{t('appointments.move')}</Button>
                  <Button variant="ghost" size="sm" onClick={() => { setCancelling(a); setProblem(null) }}>{t('appointments.cancel')}</Button>
                </div>
              )}
              {a.status === 'CONFIRMED' && !a.canChange && <p className="text-caption text-subtle">{t('appointments.tooLate')}</p>}
              {cancelling?.appointmentId === a.appointmentId && (
                <div className="space-y-2 rounded-2xl bg-surface-2 p-4">
                  <p className="text-body text-fg">{t('appointments.confirmCancel')}</p>
                  <label className="block text-caption text-muted">
                    {t('appointments.cancelReason')}
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} className="mt-1 w-full rounded-xl border border-border bg-surface p-3 text-body text-fg" />
                  </label>
                  {problem && <p role="alert" className="text-caption text-danger">{problem}</p>}
                  <div className="flex gap-2">
                    <Button variant="danger" size="sm" onClick={cancel} disabled={busy} loading={busy}>{t('appointments.cancelYes')}</Button>
                    <Button variant="ghost" size="sm" onClick={() => setCancelling(null)} disabled={busy}>{t('appointments.keep')}</Button>
                  </div>
                </div>
              )}
            </Card>
          </StaggerItem>
        ))}
      </StaggerList>
    </div>
  )
}
