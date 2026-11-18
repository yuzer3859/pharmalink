import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { newOfferIds, playOfferAlert, unlockSound } from '../alerts/offerAlert'
import {
  activeJobs,
  availabilityErrorMessage,
  birr,
  distanceLabel,
  liveOffers,
  offerErrorMessage,
  secondsLeft,
} from '../jobs/driverService'
import { useDriverJobs, useDriverService, useLocationReporter, useNow } from '../jobs/hooks'
import { STATUS_TEXT } from '../jobs/jobSteps'

// The backend's BRULE-09 reasons (module-08 identity port).
const REASONS = {
  DOCUMENTS_NOT_APPROVED: 'PharmaLink has not approved your driving documents yet. Operations will tell you when they have.',
  DOCUMENTS_EXPIRED: 'Your driving documents have expired. Send new ones to PharmaLink operations.',
  ACCOUNT_NOT_ACTIVE: 'Your account is not active. Contact PharmaLink operations.',
  NOT_A_DRIVER: 'This account is not set up as a driver.',
}

/** What the driver needs to know first: whether they may drive yet. */
export function verificationText(verification) {
  if (!verification) return null
  if (verification.isEligible) return null
  return REASONS[verification.reason] ?? 'You are not verified to drive yet. Contact PharmaLink operations.'
}

const LOCATION_TEXT = {
  locating: 'Finding your location…',
  sharing: 'Sharing your location with dispatch while you are online.',
  denied: 'Location is blocked. Allow it in the browser, or you will not be offered jobs.',
  unavailable: 'This device cannot share its location, so you will not be offered jobs.',
}

/** Work 141: sound and vibrate when an offer appears that was not there at the last check. */
function useOfferAlert(offers) {
  const seen = useRef(new Set())
  useEffect(() => {
    const fresh = newOfferIds(seen.current, offers)
    for (const id of fresh) seen.current.add(id)
    if (fresh.length) playOfferAlert()
  }, [offers])
}

/** The offer's time left, as a ring that empties. */
function Countdown({ left, total }) {
  const r = 22
  const c = 2 * Math.PI * r
  const share = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0
  return (
    <div className="relative grid h-14 w-14 place-items-center" aria-label="Seconds left">
      <svg viewBox="0 0 52 52" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="26" cy="26" r={r} fill="none" stroke="currentColor" strokeWidth="5" className="text-brand-100" />
        <circle cx="26" cy="26" r={r} fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - share)} className={left <= 10 ? 'text-danger' : 'text-brand-600'} />
      </svg>
      <span className="text-base font-bold tabular-nums">{left}s</span>
    </div>
  )
}

function Stop({ kind, title, text }) {
  return (
    <div className="flex gap-3">
      <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${kind === 'pickup' ? 'bg-brand-600' : 'bg-warning'}`} aria-hidden="true" />
      <div className="min-w-0">
        <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</dt>
        <dd className="break-words font-medium">{text}</dd>
      </div>
    </div>
  )
}

function OfferCard({ offer, now, onDone }) {
  const service = useDriverService()
  const [state, setState] = useState({ busy: false, error: null })
  const left = secondsLeft(offer.expiresAt, now)
  const total = Math.max(1, Math.round((Date.parse(offer.expiresAt) - Date.parse(offer.offeredAt)) / 1000))
  const job = offer.job
  async function act(kind) {
    setState({ busy: true, error: null })
    try {
      if (kind === 'accept') await service.accept(job.jobId)
      else await service.decline(job.jobId)
      onDone()
    } catch (error) {
      setState({ busy: false, error: offerErrorMessage(error) })
      onDone()
    }
  }
  return (
    <article className="overflow-hidden rounded-2xl bg-white shadow-lg ring-2 ring-brand-500" aria-label="Delivery offer">
      <div className="flex items-center justify-between bg-brand-700 px-4 py-3 text-white">
        <div>
          <h2 className="text-lg font-bold">New delivery</h2>
          {distanceLabel(job.distanceMeters) ? <p className="text-sm text-brand-100">{distanceLabel(job.distanceMeters)} away</p> : null}
        </div>
        <div className="rounded-full bg-white text-slate-900">
          <Countdown left={left} total={total} />
        </div>
      </div>
      <div className="p-4">
        <dl className="grid gap-3 text-sm">
          <Stop kind="pickup" title="Pick up" text={job.pickupAddress ?? 'Pharmacy'} />
          <Stop kind="dropoff" title="Deliver to" text={job.dropoffAddress ?? 'Customer'} />
        </dl>
        {job.isCod || job.isColdChain || job.paper ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
            {job.isCod ? <span className="rounded-full bg-warning-soft px-2.5 py-1 text-warning">Collect cash: {birr(job.codAmount ?? 0)}</span> : null}
            {job.isColdChain ? <span className="rounded-full bg-brand-50 px-2.5 py-1 text-brand-700">Keep cold</span> : null}
            {job.paper ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">Paper prescription: customer first</span> : null}
          </div>
        ) : null}
        {state.error ? <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p> : null}
        <div className="mt-4 grid grid-cols-5 gap-2">
          <button type="button" disabled={state.busy || left === 0} onClick={() => act('decline')} className="col-span-2 rounded-xl border border-slate-300 py-3.5 font-semibold disabled:opacity-50">
            Decline
          </button>
          <button type="button" disabled={state.busy || left === 0} onClick={() => act('accept')} className="col-span-3 rounded-xl bg-brand-700 py-3.5 text-lg font-bold text-white shadow disabled:opacity-50">
            Accept
          </button>
        </div>
      </div>
    </article>
  )
}

/**
 * Work 119: availability and offers. Going online starts the shift (the backend's rule) and shares
 * the location while online; offers are polled every 5 s with a countdown to their expiry.
 * Work 141: a cleaner layout, and a sound when an offer appears.
 */
export default function Home() {
  const { driver, logout, setProfile } = useAuth()
  const service = useDriverService()
  const profile = driver?.profile
  const notVerified = verificationText(profile?.verification)
  const online = profile?.availability === 'ONLINE'
  const [toggle, setToggle] = useState({ busy: false, error: null })
  const jobs = useDriverJobs(!notVerified && online)
  const offers = liveOffers(jobs.data?.offers)
  const now = useNow(offers.length > 0)
  const locationStatus = useLocationReporter(!notVerified && online)
  const working = activeJobs(jobs.data?.items)
  const delivered = useLocation().state?.delivered
  useOfferAlert(jobs.data?.offers)

  async function setAvailability(status) {
    if (status === 'ONLINE') unlockSound()
    setToggle({ busy: true, error: null })
    try {
      setProfile(await service.setAvailability(status))
      setToggle({ busy: false, error: null })
    } catch (error) {
      setToggle({ busy: false, error: availabilityErrorMessage(error) })
    }
  }

  return (
    <div className="min-h-full">
      <header className="bg-gradient-to-br from-brand-700 to-brand-800 px-5 pb-16 pt-6 text-white">
        <div className="mx-auto flex max-w-md items-center justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">PharmaLink Driver</h1>
            <p className="truncate text-sm text-brand-100">{driver?.user?.email}</p>
          </div>
          <button type="button" onClick={logout} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium ring-1 ring-white/30">
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto -mt-12 max-w-md px-5 pb-8">
        {notVerified ? (
          <p role="status" className="rounded-2xl bg-white p-4 text-sm shadow ring-1 ring-warning/40">
            {notVerified}
          </p>
        ) : (
          <section className="rounded-2xl bg-white p-4 shadow" aria-label="Status">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className={`relative flex h-3.5 w-3.5 ${online ? '' : 'opacity-60'}`} aria-hidden="true">
                  {online ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" /> : null}
                  <span className={`relative inline-flex h-3.5 w-3.5 rounded-full ${online ? 'bg-success' : 'bg-slate-400'}`} />
                </span>
                <div>
                  <p className="text-xs text-slate-500">You are</p>
                  <p className="text-lg font-bold leading-tight">{online ? 'Online' : 'Offline'}</p>
                </div>
              </div>
              <button
                type="button"
                disabled={toggle.busy}
                onClick={() => setAvailability(online ? 'OFFLINE' : 'ONLINE')}
                className={`rounded-xl px-5 py-3 font-bold text-white shadow disabled:opacity-60 ${online ? 'bg-slate-700' : 'bg-success'}`}
              >
                {toggle.busy ? 'Please wait…' : online ? 'Go offline' : 'Go online'}
              </button>
            </div>
            {profile?.vehicle ? (
              <p className="mt-2 text-sm capitalize text-slate-600">
                {profile.vehicle.type.toLowerCase()}
                {profile.vehicle.plateNumber ? ` · ${profile.vehicle.plateNumber}` : ''}
              </p>
            ) : null}
            {online && LOCATION_TEXT[locationStatus] ? <p className="mt-2 text-xs text-slate-600" role="status">{LOCATION_TEXT[locationStatus]}</p> : null}
            {toggle.error ? <p role="alert" className="mt-2 text-sm text-danger">{toggle.error}</p> : null}
          </section>
        )}

        {delivered ? (
          <p role="status" className="mt-4 rounded-xl bg-success-soft px-3 py-2.5 text-sm font-semibold">Delivered. Thank you!</p>
        ) : null}

        {online ? (
          <section className="mt-5 grid gap-4" aria-label="Offers">
            {offers.map((offer) => (
              <OfferCard key={offer.offerId} offer={offer} now={now} onDone={jobs.reload} />
            ))}
            {offers.length === 0 && working.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-4 py-8 text-center">
                <p className="text-sm text-slate-500">Waiting for a delivery offer…</p>
                <p className="mt-1 text-xs text-slate-400">Keep this screen open: a sound plays when one arrives.</p>
              </div>
            ) : null}
            {jobs.error?.status === 0 ? <p className="text-center text-sm text-warning" role="status">No connection. Retrying…</p> : null}
          </section>
        ) : null}

        {working.length > 0 ? (
          <section className="mt-6 grid gap-2" aria-label="Your deliveries">
            <h2 className="text-sm font-semibold text-slate-600">Your deliveries</h2>
            {working.map((job) => (
              <Link key={job.jobId} to={`/jobs/${job.jobId}`} className="flex items-center justify-between gap-3 rounded-2xl bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200">
                <div className="min-w-0">
                  <p className="font-semibold">{STATUS_TEXT[job.status] ?? job.status}</p>
                  <p className="text-xs uppercase tracking-wide text-slate-400">{job.status.replace(/_/g, ' ').toLowerCase()}</p>
                  <p className="mt-1 truncate text-slate-600">{job.dropoffAddress ?? 'Customer'}</p>
                </div>
                <span className="shrink-0 rounded-full bg-brand-700 px-3 py-1.5 font-semibold text-white">Open →</span>
              </Link>
            ))}
          </section>
        ) : null}

        <nav className="mt-6 grid grid-cols-2 gap-2" aria-label="Money">
          <Link to="/earnings" className="rounded-xl bg-white py-3 text-center text-sm font-semibold shadow-sm ring-1 ring-slate-200">Earnings</Link>
          <Link to="/cash" className="rounded-xl bg-white py-3 text-center text-sm font-semibold shadow-sm ring-1 ring-slate-200">Cash collected</Link>
        </nav>
      </main>
    </div>
  )
}
