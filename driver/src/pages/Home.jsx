import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
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

function OfferCard({ offer, now, onDone }) {
  const service = useDriverService()
  const [state, setState] = useState({ busy: false, error: null })
  const left = secondsLeft(offer.expiresAt, now)
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
    <article className="rounded-xl border-2 border-brand-500 bg-white p-4" aria-label="Delivery offer">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">New delivery</h2>
        <span className="rounded-full bg-brand-50 px-2.5 py-1 text-sm font-semibold text-brand-800" aria-label="Seconds left">
          {left}s
        </span>
      </div>
      <dl className="mt-2 grid gap-1 text-sm">
        <div><dt className="inline text-slate-500">Pick up: </dt><dd className="inline">{job.pickupAddress ?? 'Pharmacy'}</dd></div>
        <div><dt className="inline text-slate-500">Deliver to: </dt><dd className="inline">{job.dropoffAddress ?? 'Customer'}</dd></div>
        {distanceLabel(job.distanceMeters) ? <div><dt className="inline text-slate-500">Distance: </dt><dd className="inline">{distanceLabel(job.distanceMeters)}</dd></div> : null}
        {job.isCod ? <div className="font-semibold text-warning">Collect cash: {birr(job.codAmount ?? 0)}</div> : null}
        {job.isColdChain ? <div className="font-semibold text-brand-700">Keep cold</div> : null}
      </dl>
      {state.error ? <p role="alert" className="mt-2 text-sm text-danger">{state.error}</p> : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" disabled={state.busy || left === 0} onClick={() => act('decline')} className="rounded-lg border border-slate-300 py-3 font-semibold disabled:opacity-50">
          Decline
        </button>
        <button type="button" disabled={state.busy || left === 0} onClick={() => act('accept')} className="rounded-lg bg-brand-700 py-3 font-semibold text-white disabled:opacity-50">
          Accept
        </button>
      </div>
    </article>
  )
}

/**
 * Work 119: availability and offers. Going online starts the shift (the backend's rule) and shares
 * the location while online; offers are polled every 5 s with a countdown to their expiry.
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

  async function setAvailability(status) {
    setToggle({ busy: true, error: null })
    try {
      setProfile(await service.setAvailability(status))
      setToggle({ busy: false, error: null })
    } catch (error) {
      setToggle({ busy: false, error: availabilityErrorMessage(error) })
    }
  }

  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-brand-800">PharmaLink Driver</h1>
          <p className="text-sm text-slate-600">{driver?.user?.email}</p>
        </div>
        <button type="button" onClick={logout} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">
          Sign out
        </button>
      </header>

      <nav className="mt-4 grid grid-cols-2 gap-2" aria-label="Money">
        <Link to="/earnings" className="rounded-lg border border-slate-300 bg-white py-2 text-center text-sm font-semibold">Earnings</Link>
        <Link to="/cash" className="rounded-lg border border-slate-300 bg-white py-2 text-center text-sm font-semibold">Cash collected</Link>
      </nav>

      {delivered ? (
        <p role="status" className="mt-5 rounded-lg bg-success-soft px-3 py-2 text-sm font-semibold">Delivered. Thank you!</p>
      ) : null}

      {notVerified ? (
        <p role="status" className="mt-5 rounded-lg bg-warning-soft px-3 py-2 text-sm">
          {notVerified}
        </p>
      ) : (
        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-label="Status">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-600">You are</p>
              <p className="text-lg font-semibold">{online ? 'Online' : 'Offline'}</p>
            </div>
            <button
              type="button"
              disabled={toggle.busy}
              onClick={() => setAvailability(online ? 'OFFLINE' : 'ONLINE')}
              className={`rounded-lg px-4 py-2.5 font-semibold text-white disabled:opacity-60 ${online ? 'bg-slate-700' : 'bg-success'}`}
            >
              {toggle.busy ? 'Please wait…' : online ? 'Go offline' : 'Go online'}
            </button>
          </div>
          {profile?.vehicle ? (
            <p className="mt-1 text-sm text-slate-600">
              {profile.vehicle.type.toLowerCase()}
              {profile.vehicle.plateNumber ? ` · ${profile.vehicle.plateNumber}` : ''}
            </p>
          ) : null}
          {online && LOCATION_TEXT[locationStatus] ? <p className="mt-2 text-xs text-slate-600" role="status">{LOCATION_TEXT[locationStatus]}</p> : null}
          {toggle.error ? <p role="alert" className="mt-2 text-sm text-danger">{toggle.error}</p> : null}
        </section>
      )}

      {online ? (
        <section className="mt-5 grid gap-3" aria-label="Offers">
          {offers.map((offer) => (
            <OfferCard key={offer.offerId} offer={offer} now={now} onDone={jobs.reload} />
          ))}
          {offers.length === 0 && working.length === 0 ? (
            <p className="text-center text-sm text-slate-500">Waiting for a delivery offer…</p>
          ) : null}
          {jobs.error?.status === 0 ? <p className="text-center text-sm text-warning" role="status">No connection. Retrying…</p> : null}
        </section>
      ) : null}

      {working.length > 0 ? (
        <section className="mt-5 grid gap-2" aria-label="Your deliveries">
          <h2 className="text-sm font-semibold text-slate-600">Your deliveries</h2>
          {working.map((job) => (
            <Link key={job.jobId} to={`/jobs/${job.jobId}`} className="block rounded-xl border border-slate-200 bg-white p-3 text-sm">
              <p className="font-semibold">{job.status.replace(/_/g, ' ').toLowerCase()}</p>
              <p className="text-slate-600">{job.dropoffAddress ?? 'Customer'}</p>
              <p className="mt-1 font-semibold text-brand-700">Open →</p>
            </Link>
          ))}
        </section>
      ) : null}
    </main>
  )
}
