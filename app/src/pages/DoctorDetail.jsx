import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Building2, CalendarCheck, Stethoscope, Video } from 'lucide-react'
import { Badge, Button, Card, Segmented, Skeleton } from '../components/ui'
import { PageHero } from '../components/PageHero'
import { formatMinorUnits } from '../lib/utils'
import { useAuth } from '../auth/AuthContext'
import { SLOT_DAYS, addDays, localDayLabel, localTime, localToday, slotsByDay, useAppointments, useDoctors, appointmentError } from '../doctors/doctorsService'
import { t, useLanguage } from '../auth/strings'

/**
 * Work 171: a doctor's page — who they are, where they practise, the fee — and their open times
 * for the next two weeks, in person or by video. Picking a time and confirming books it at once
 * (the fee is paid at the visit). With `?reschedule=<appointmentId>` the chosen time moves that
 * appointment instead.
 */
export default function DoctorDetail() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const rescheduleId = params.get('reschedule')
  const doctors = useDoctors()
  const appointments = useAppointments()
  const { status } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const language = useLanguage()
  const [doctor, setDoctor] = useState({ status: 'loading', data: null })
  const [type, setType] = useState('IN_PERSON')
  const [slots, setSlots] = useState({ status: 'loading', items: [] })
  const [picked, setPicked] = useState(null)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    doctors
      .doctor(id, { signal: controller.signal })
      .then((data) => setDoctor({ status: 'ready', data }))
      .catch((error) => error?.code !== 'ABORTED' && setDoctor({ status: error?.status === 404 ? 'missing' : 'error', data: null }))
    return () => controller.abort()
  }, [doctors, id])

  useEffect(() => {
    if (doctor.status !== 'ready') return undefined
    const controller = new AbortController()
    const from = localToday()
    setSlots({ status: 'loading', items: [] })
    setPicked(null)
    doctors
      .slots(id, { from, to: addDays(from, SLOT_DAYS - 1), type }, { signal: controller.signal })
      .then((items) => setSlots({ status: 'ready', items }))
      .catch((error) => error?.code !== 'ABORTED' && setSlots({ status: 'error', items: [] }))
    return () => controller.abort()
  }, [doctors, id, type, doctor.status, attempt])

  const days = useMemo(() => slotsByDay(slots.items), [slots.items])
  const back = (
    <Link to="/doctors" className="inline-flex items-center gap-1 text-caption font-semibold text-brand-600">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('doctors.back')}
    </Link>
  )

  if (doctor.status === 'loading') return <div className="space-y-4">{back}<Skeleton className="h-40" /><Skeleton className="h-48" /></div>
  if (doctor.status !== 'ready') {
    return (
      <div className="space-y-4">
        {back}
        <Card className="p-8 text-center text-body text-fg">{t(doctor.status === 'missing' ? 'doctors.missing' : 'search.unavailable')}</Card>
      </div>
    )
  }

  const d = doctor.data
  const fee = type === 'TELEMEDICINE' ? d.consultationFeeTele : d.consultationFeeInPerson

  async function confirm() {
    setSaving(true)
    setProblem(null)
    try {
      if (rescheduleId) await appointments.reschedule(rescheduleId, picked.slotId)
      else await appointments.book({ slotId: picked.slotId, appointmentType: type, reasonNote: reason })
      navigate('/appointments', { state: { notice: rescheduleId ? 'moved' : 'booked' } })
    } catch (error) {
      setProblem(appointmentError(error))
      if (error?.code === 'SLOT_UNAVAILABLE') setAttempt((n) => n + 1)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {back}
      <PageHero icon={Stethoscope} title={d.fullName} subtitle={d.fullNameAm ?? undefined} pictures={[]}>
        {d.specialty && <Badge tone="info">{d.specialty}</Badge>}
        {d.acceptsTelemedicine && <Badge tone="brand"><Video className="h-3 w-3" aria-hidden="true" /> {t('doctors.video')}</Badge>}
      </PageHero>

      <Card className="space-y-2 p-5">
        {d.bio && <p className="text-body text-fg">{d.bio}</p>}
        <p className="text-caption text-muted">
          {[d.subSpecialties?.join(', '), d.yearsExperience ? t('doctors.experience', { years: d.yearsExperience }) : null, d.languages.length ? d.languages.join(', ') : null].filter(Boolean).join(' · ')}
        </p>
        {d.affiliations.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {d.affiliations.map((a) => (
              <Link key={a.providerId} to={`/care/${a.providerId}`} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-3 py-1 text-caption font-semibold text-brand-600">
                <Building2 className="h-3.5 w-3.5" aria-hidden="true" /> {a.providerName}{a.departmentName ? `, ${a.departmentName}` : ''}
              </Link>
            ))}
          </div>
        )}
      </Card>

      <section className="space-y-3" aria-labelledby="times">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="times" className="font-display text-h3 text-fg">{t(rescheduleId ? 'doctors.pickNewTime' : 'doctors.pickTime')}</h2>
          {d.acceptsTelemedicine && !rescheduleId && (
            <Segmented
              options={[{ value: 'IN_PERSON', label: t('doctors.inPerson') }, { value: 'TELEMEDICINE', label: t('doctors.video') }]}
              value={type}
              onChange={setType}
            />
          )}
        </div>
        {fee !== null && fee !== undefined && <p className="text-caption text-muted">{t('doctors.feeAtVisit', { fee: formatMinorUnits(fee, d.currency) })}</p>}
        {slots.status === 'loading' && <Skeleton className="h-32" />}
        {slots.status === 'error' && <Card className="p-6 text-center text-body text-fg">{t('search.unavailable')}</Card>}
        {slots.status === 'ready' && days.length === 0 && <Card className="p-6 text-center text-body text-fg">{t('doctors.noTimes')}</Card>}
        <div className="space-y-3">
          {days.map(({ date, items }) => (
            <div key={date}>
              <p className="mb-1.5 text-caption font-semibold text-fg">{localDayLabel(items[0].startAt, language)}</p>
              <div className="flex flex-wrap gap-2">
                {items.map((s) => (
                  <button
                    key={s.slotId}
                    type="button"
                    aria-pressed={picked?.slotId === s.slotId}
                    onClick={() => setPicked(s)}
                    className={`rounded-xl border px-3 py-2 text-caption font-semibold transition ${picked?.slotId === s.slotId ? 'border-brand-500 bg-brand-500 text-white' : 'border-border bg-surface text-fg hover:border-brand-400'}`}
                  >
                    {localTime(s.startAt)}
                    {s.location?.name ? <span className="block text-[11px] font-normal opacity-80">{s.location.name}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {picked && (
        <Card className="space-y-3 p-5">
          <p className="text-body font-semibold text-fg">
            {t('doctors.confirmWhen', { when: `${localDayLabel(picked.startAt, language)}, ${localTime(picked.startAt)}` })}
            {picked.location?.name ? ` · ${picked.location.name}` : type === 'TELEMEDICINE' ? ` · ${t('doctors.video')}` : ''}
          </p>
          {status === 'signedIn' ? (
            <>
              {!rescheduleId && (
                <label className="block text-caption text-muted">
                  {t('doctors.reason')}
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} className="mt-1 w-full rounded-xl border border-border bg-surface p-3 text-body text-fg" />
                </label>
              )}
              {problem && <p role="alert" className="text-caption text-danger">{problem}</p>}
              <Button onClick={confirm} disabled={saving} loading={saving}>
                <CalendarCheck className="h-4 w-4" aria-hidden="true" /> {t(rescheduleId ? 'doctors.moveHere' : 'doctors.book')}
              </Button>
              <p className="text-caption text-subtle">{t('doctors.payAtVisit')}</p>
            </>
          ) : (
            <Button as={Link} to="/login" state={{ from: location.pathname + location.search }}>
              {t('doctors.signInToBook')}
            </Button>
          )}
        </Card>
      )}
    </div>
  )
}
