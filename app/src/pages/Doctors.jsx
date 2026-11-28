import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Stethoscope, Search as SearchIcon, MapPin, Navigation, RefreshCw, Video, ArrowRight, CalendarClock } from 'lucide-react'
import { Badge, Button, Card, Input, Skeleton } from '../components/ui'
import { PageHero, StaggerItem, StaggerList } from '../components/PageHero'
import { PAGE_PICTURES } from '../catalog/images'
import { formatMinorUnits } from '../lib/utils'
import { requestLocation } from '../search/searchService'
import { DOCTOR_PAGE_SIZE, localDayLabel, localTime, useDoctors } from '../doctors/doctorsService'
import { t, useLanguage } from '../auth/strings'

const DEBOUNCE_MS = 350

function readFilters(params) {
  const lat = Number(params.get('lat'))
  const lng = Number(params.get('lng'))
  const page = Number(params.get('page'))
  return {
    q: (params.get('q') ?? '').slice(0, 120),
    telemedicine: params.get('video') === '1',
    availableOnly: params.get('free') === '1',
    location: params.has('lat') && params.has('lng') && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
    page: Number.isInteger(page) && page > 1 ? page : 1,
  }
}

function DoctorCard({ hit, language }) {
  return (
    <Card interactive>
      <Link to={`/doctors/${hit.doctorId}`} className="flex items-start gap-4 rounded-2xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-600">
          <Stethoscope className="h-6 w-6" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body-lg font-semibold text-fg">{hit.fullName}</p>
            {hit.specialty && <Badge tone="info">{hit.specialty}</Badge>}
            {hit.acceptsTelemedicine && <Badge tone="brand"><Video className="h-3 w-3" aria-hidden="true" /> {t('doctors.video')}</Badge>}
          </div>
          {hit.fullNameAm && <p className="text-caption text-muted" lang="am">{hit.fullNameAm}</p>}
          {hit.practices.length > 0 && <p className="mt-1 text-caption text-muted">{hit.practices.map((p) => p.name).join(' · ')}</p>}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 text-caption">
            {hit.nextAvailableAt ? (
              <span className="inline-flex items-center gap-1 text-success">
                <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                {t('doctors.nextFree', { when: `${localDayLabel(hit.nextAvailableAt, language)}, ${localTime(hit.nextAvailableAt)}` })}
              </span>
            ) : (
              <span className="text-muted">{t('doctors.noFreeTimes')}</span>
            )}
            {hit.feeInPerson !== null && <span className="text-muted">{t('doctors.fee', { fee: formatMinorUnits(hit.feeInPerson, hit.currency) })}</span>}
          </p>
        </div>
        <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
      </Link>
    </Card>
  )
}

/**
 * Work 171: find a doctor (Module 10) by name, specialty, hospital or language — typo-tolerant —
 * soonest available first; filter by video appointments and free times; nearest first after
 * "Near me". The location is asked for only then and kept only in this page's URL.
 */
export default function Doctors() {
  const doctors = useDoctors()
  const language = useLanguage()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const [text, setText] = useState(filters.q)
  const [results, setResults] = useState({ status: 'loading', items: [], total: 0, didYouMean: null })
  const [attempt, setAttempt] = useState(0)
  const [locating, setLocating] = useState(false)
  const [noLocation, setNoLocation] = useState(false)
  const latest = useRef(0)

  function update(changes, { resetPage = true } = {}) {
    setParams((current) => {
      const next = new URLSearchParams(current)
      for (const [key, value] of Object.entries(changes)) {
        if (value === '' || value === null || value === undefined || value === false) next.delete(key)
        else next.set(key, String(value))
      }
      if (resetPage) next.delete('page')
      return next
    }, { replace: true })
  }

  useEffect(() => {
    if (text.trim() === filters.q.trim()) return undefined
    const timer = setTimeout(() => update({ q: text.trim() }), DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  useEffect(() => {
    const id = ++latest.current
    const controller = new AbortController()
    setResults((r) => ({ ...r, status: 'loading' }))
    doctors
      .search(filters, { signal: controller.signal })
      .then((data) => id === latest.current && setResults({ status: 'ready', ...data }))
      .catch((error) => id === latest.current && error?.code !== 'ABORTED' && setResults({ status: 'error', items: [], total: 0, didYouMean: null }))
    return () => controller.abort()
  }, [doctors, filters, attempt])

  async function nearMe() {
    setLocating(true)
    setNoLocation(false)
    const location = await requestLocation()
    setLocating(false)
    if (!location) return setNoLocation(true)
    update({ lat: location.lat, lng: location.lng })
  }

  const pages = Math.max(1, Math.ceil(results.total / DOCTOR_PAGE_SIZE))

  return (
    <div className="space-y-6">
      <PageHero icon={Stethoscope} title={t('doctors.title')} subtitle={t('doctors.subtitle')} pictures={PAGE_PICTURES.doctors} />
      <div className="space-y-3">
        <Input type="search" role="searchbox" aria-label={t('doctors.search')} icon={SearchIcon} placeholder={t('doctors.placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-caption text-muted">
            <input type="checkbox" checked={filters.telemedicine} onChange={(e) => update({ video: e.target.checked ? '1' : '' })} />
            {t('doctors.videoOnly')}
          </label>
          <label className="flex items-center gap-2 text-caption text-muted">
            <input type="checkbox" checked={filters.availableOnly} onChange={(e) => update({ free: e.target.checked ? '1' : '' })} />
            {t('doctors.freeOnly')}
          </label>
          {filters.location ? (
            <>
              <Badge tone="info"><MapPin className="h-3.5 w-3.5" aria-hidden="true" /> {t('search.nearYou')}</Badge>
              <Button variant="ghost" size="sm" onClick={() => update({ lat: '', lng: '' })}>{t('search.clearLocation')}</Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={nearMe} disabled={locating}>
              <Navigation className="h-4 w-4" aria-hidden="true" /> {t(locating ? 'checkout.location.finding' : 'search.nearMe')}
            </Button>
          )}
        </div>
        {noLocation && <p role="status" className="text-caption text-muted">{t('care.noLocation')}</p>}
      </div>

      <section aria-live="polite" aria-busy={results.status === 'loading'}>
        {results.status === 'loading' && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>}
        {results.status === 'error' && (
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-body text-fg">{t('search.unavailable')}</p>
            <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}
            </Button>
          </Card>
        )}
        {results.status === 'ready' && results.items.length === 0 && (
          <Card className="p-8 text-center text-body text-fg">{filters.q ? t('doctors.noMatch.query', { query: filters.q }) : t('doctors.noMatch.filters')}</Card>
        )}
        {results.status === 'ready' && results.items.length > 0 && (
          <div className="space-y-3">
            {results.didYouMean && (
              <p role="status" className="rounded-2xl bg-brand-50 px-4 py-3 text-body text-fg">{t('search.didYouMean', { query: filters.q, suggestion: results.didYouMean })}</p>
            )}
            <StaggerList className="space-y-3">
              {results.items.map((hit) => (
                <StaggerItem key={hit.doctorId}>
                  <DoctorCard hit={hit} language={language} />
                </StaggerItem>
              ))}
            </StaggerList>
            {pages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <Button variant="ghost" size="sm" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 }, { resetPage: false })}>{t('common.previous')}</Button>
                <span className="text-caption text-muted">{t('common.pageOf', { page: filters.page, pages })}</span>
                <Button variant="ghost" size="sm" disabled={filters.page >= pages} onClick={() => update({ page: filters.page + 1 }, { resetPage: false })}>{t('common.next')}</Button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
