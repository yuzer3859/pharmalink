import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Building2, Clock, ExternalLink, Globe, MapPin, Phone, Siren, FlaskConical } from 'lucide-react'
import { Badge, Button, Card, Skeleton } from '../components/ui'
import { PageHero } from '../components/PageHero'
import { formatMinorUnits } from '../lib/utils'
import { mapLink, useCare } from '../care/careService'
import { providerTypeLabel } from './Care'
import { t } from '../auth/strings'

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function Hours({ hours }) {
  if (hours.length === 0) return <p className="text-caption text-muted">{t('care.hours.unknown')}</p>
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-caption text-muted sm:grid-cols-3">
      {hours.map((h) => (
        <li key={h.weekday}>
          <span className="font-semibold text-fg">{t(`care.day.${WEEKDAY_KEYS[h.weekday]}`)}</span> {h.isClosed ? t('care.hours.closed') : `${h.openTime}–${h.closeTime}`}
        </li>
      ))}
    </ul>
  )
}

/**
 * Work 165: a provider's public page — what it is, how to reach it, its locations with opening
 * hours, emergency service, facilities and a map link, its departments, and the tests it offers
 * with price and preparation. Booking online comes with Modules 10 and 11.
 */
export default function ProviderDetail() {
  const { id } = useParams()
  const care = useCare()
  const [state, setState] = useState({ status: 'loading', provider: null })

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading', provider: null })
    care
      .provider(id, { signal: controller.signal })
      .then((provider) => setState({ status: 'ready', provider }))
      .catch((error) => error?.code !== 'ABORTED' && setState({ status: error?.status === 404 ? 'missing' : 'error', provider: null }))
    return () => controller.abort()
  }, [care, id])

  const back = (
    <Link to="/care" className="inline-flex items-center gap-1 text-caption font-semibold text-brand-600">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('care.back')}
    </Link>
  )

  if (state.status === 'loading') return <div className="space-y-4">{back}<Skeleton className="h-40" /><Skeleton className="h-32" /></div>
  if (state.status !== 'ready') {
    return (
      <div className="space-y-4">
        {back}
        <Card className="p-8 text-center text-body text-fg">{t(state.status === 'missing' ? 'care.missing' : 'search.unavailable')}</Card>
      </div>
    )
  }

  const p = state.provider
  return (
    <div className="space-y-6">
      {back}
      <PageHero icon={Building2} title={p.displayName} subtitle={p.nameAm ?? undefined} pictures={[]}>
        <Badge tone="info">{providerTypeLabel(p.type)}</Badge>
        {p.locations.some((l) => l.emergencyAvailability === 'H24_7') && <Badge tone="danger">{t('care.emergency24')}</Badge>}
      </PageHero>

      {(p.description || p.contactPhone || p.website) && (
        <Card className="space-y-2 p-5">
          {p.description && <p className="text-body text-fg">{p.description}</p>}
          <div className="flex flex-wrap gap-3">
            {p.contactPhone && (
              <a href={`tel:${p.contactPhone.replace(/[^+\d]/g, '')}`} className="inline-flex items-center gap-1 text-body font-semibold text-brand-600">
                <Phone className="h-4 w-4" aria-hidden="true" /> {p.contactPhone}
              </a>
            )}
            {p.website && /^https?:\/\//i.test(p.website) && (
              <a href={p.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-body font-semibold text-brand-600">
                <Globe className="h-4 w-4" aria-hidden="true" /> {t('care.website')}
              </a>
            )}
          </div>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="font-display text-h3 text-fg">{t('care.locations')}</h2>
        {p.locations.length === 0 && <p className="text-body text-muted">{t('care.noLocations')}</p>}
        {p.locations.map((l) => {
          const map = mapLink(l.lat, l.lng)
          return (
            <Card key={l.locationId} className="space-y-2 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-body-lg font-semibold text-fg">{l.name}</p>
                {l.emergencyAvailability === 'H24_7' && <Badge tone="danger"><Siren className="h-3 w-3" aria-hidden="true" /> {t('care.emergency24')}</Badge>}
                {l.emergencyAvailability === 'BUSINESS_HOURS' && <Badge tone="warning">{t('care.emergencyHours')}</Badge>}
              </div>
              <p className="flex items-center gap-1 text-caption text-muted">
                <MapPin className="h-3.5 w-3.5" aria-hidden="true" /> {[l.addressLine, l.subcity, l.city].filter(Boolean).join(', ')}
              </p>
              {l.phone && <p className="flex items-center gap-1 text-caption text-muted"><Phone className="h-3.5 w-3.5" aria-hidden="true" /> {l.phone}</p>}
              <div className="flex items-start gap-1">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden="true" />
                <Hours hours={l.hours} />
              </div>
              {l.facilities.length > 0 && (
                <div className="flex flex-wrap gap-1.5">{l.facilities.map((f) => <Badge key={f}>{f}</Badge>)}</div>
              )}
              {map && (
                <Button as="a" href={map} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm">
                  <ExternalLink className="h-4 w-4" aria-hidden="true" /> {t('care.directions')}
                </Button>
              )}
            </Card>
          )
        })}
      </section>

      {p.departments.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-h3 text-fg">{t('care.departments')}</h2>
          <div className="flex flex-wrap gap-2">
            {p.departments.map((d) => <Badge key={d.departmentId} tone="brand">{d.name}</Badge>)}
          </div>
        </section>
      )}

      {p.services.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-h3 text-fg">{t('care.services')}</h2>
          <div className="space-y-2">
            {p.services.map((s) => (
              <Card key={s.serviceId} className="flex items-start gap-3 p-4">
                <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-fg">{s.name}</p>
                  {s.preparationInstructions && <p className="text-caption text-muted">{s.preparationInstructions}</p>}
                </div>
                <p className="shrink-0 text-body font-semibold text-fg">{s.price === null ? t('care.priceOnRequest') : formatMinorUnits(s.price, s.currency)}</p>
              </Card>
            ))}
          </div>
          <p className="text-caption text-subtle">{t('care.bookingLater')}</p>
        </section>
      )}
    </div>
  )
}
