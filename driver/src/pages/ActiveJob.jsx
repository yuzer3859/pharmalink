import { lazy, Suspense, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { birr } from '../jobs/driverService'
import { useDriverJobs, useDriverService } from '../jobs/hooks'
import { canFail, collectsPaperFirst, destination, directionsLink, headline, nextStep, sharesLiveLocation, stepErrorMessage, validPoint, waitsForPharmacist } from '../jobs/jobSteps'
import { useJobTracking } from '../jobs/useJobTracking'

// Work 141: the map loads on its own, so the job's steps never wait for it.
const JobMap = lazy(() => import('../map/JobMap'))

const TRACKING_TEXT = {
  locating: 'Finding your location…',
  sharing: 'The customer can follow you live.',
  denied: 'Location is blocked. Allow it in the browser so the customer can follow the delivery.',
  unavailable: 'This device cannot share its location.',
  offline: 'Live tracking is reconnecting…',
}

/**
 * Work 120: the active job. Where to go next (pickup, then the customer) with a maps link, the one
 * step that comes next, and live location for the customer while the job is open. Proof of delivery
 * at the door is Work 121.
 */
export default function ActiveJob() {
  const { jobId } = useParams()
  const service = useDriverService()
  const jobs = useDriverJobs(true)
  const job = jobs.data?.items?.find((j) => j.jobId === jobId) ?? null
  const live = !!job && sharesLiveLocation(job.status)
  const tracking = useJobTracking(jobId, live)
  const [state, setState] = useState({ busy: false, error: null })
  const [failing, setFailing] = useState(false)
  const [reason, setReason] = useState('')

  const step = job ? nextStep(job.status, job) : null
  const to = destination(job)

  async function run(action) {
    setState({ busy: true, error: null })
    try {
      await action()
      setState({ busy: false, error: null })
    } catch (error) {
      setState({ busy: false, error: stepErrorMessage(error) })
    } finally {
      await jobs.reload()
    }
  }

  if (!jobs.data && !jobs.error) return <p className="p-6 text-sm text-slate-600" role="status">Loading the job…</p>
  if (!job) {
    return (
      <main className="mx-auto max-w-md px-5 py-6">
        <p className="text-sm text-slate-600">This job is not one of your deliveries any more.</p>
        <Link to="/" className="mt-3 inline-block font-semibold text-brand-700">Back</Link>
      </main>
    )
  }

  const directions = directionsLink(to)
  const me = validPoint(tracking.lastFix)

  return (
    <div className="mx-auto min-h-full max-w-md">
      {to?.point ? (
        <section className="relative h-[46vh] min-h-[260px] w-full overflow-hidden bg-slate-200" aria-label="Map">
          <Suspense fallback={<p className="grid h-full place-items-center text-sm text-slate-500">Loading the map…</p>}>
            <JobMap target={{ ...to.point, kind: to.kind }} me={me} label={to.label} />
          </Suspense>
          <Link to="/" className="absolute left-3 top-3 z-[1000] rounded-full bg-white px-3 py-2 text-sm font-semibold text-brand-700 shadow">← All deliveries</Link>
          {directions ? (
            <a href={directions} target="_blank" rel="noopener noreferrer" className="absolute bottom-6 left-3 z-[1000] flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-bold text-slate-900 shadow-lg ring-1 ring-slate-200">
              <span aria-hidden="true">➤</span> Directions in Google Maps
            </a>
          ) : null}
        </section>
      ) : null}
    <main className={`relative px-5 pb-8 ${to?.point ? '-mt-4 rounded-t-3xl bg-slate-50 pt-5 shadow-[0_-8px_24px_rgba(0,0,0,0.08)]' : 'pt-6'}`}>
      {to?.point ? null : <Link to="/" className="text-sm font-semibold text-brand-700">← All deliveries</Link>}
      <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{to?.kind === 'pickup' ? 'Heading to the pharmacy' : to ? 'Heading to the customer' : 'Delivery'}</p>
      <h1 className="mt-1 text-xl font-bold">{headline(job)}</h1>

      {job.paper ? (
        // Work 139: the original paper prescription's round trip (Work 136).
        <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-sm" role="note">
          {collectsPaperFirst(job)
            ? 'This delivery needs the original paper prescription. Go to the customer first and take the paper; then take it to the pharmacy.'
            : waitsForPharmacist(job)
              ? 'Give the paper to the pharmacist. Wait here: you pick the medicine up once they have checked it and prepared the order.'
              : job.status === 'ASSIGNED'
                ? 'You have the paper prescription. Take it to the pharmacy.'
                : 'The pharmacist has the paper prescription.'}
        </p>
      ) : null}

      {to ? (
        <section className="mt-4 flex gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200" aria-label="Destination">
          <span className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${to.kind === 'pickup' ? 'bg-brand-600' : 'bg-warning'}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-slate-500">{to.label}</p>
            <p className="break-words font-semibold">{to.address ?? 'Address not given'}</p>
            {directions ? (
              <a href={directions} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm font-semibold text-brand-700">
                {to.point ? 'Open in Google Maps' : 'Open in maps'}
              </a>
            ) : null}
            {to.point ? null : <p className="mt-1 text-xs text-slate-500">No map point for this address: search it in maps.</p>}
          </div>
        </section>
      ) : null}

      {job.isCod ? (
        <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-sm font-semibold">Collect {birr(job.codAmount ?? 0)} in cash from the customer.</p>
      ) : null}
      {job.isColdChain ? <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-800">Keep this order cold.</p> : null}
      {live && TRACKING_TEXT[tracking.status] ? <p className="mt-3 text-xs text-slate-600" role="status">{TRACKING_TEXT[tracking.status]}</p> : null}

      {state.error ? <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p> : null}
      {waitsForPharmacist(job) ? (
        <button type="button" disabled={state.busy} onClick={() => run(async () => {})} className="mt-5 w-full rounded-lg border border-slate-300 py-3 font-semibold">
          {state.busy ? 'Checking…' : 'Check again'}
        </button>
      ) : null}

      {step ? (
        <button
          type="button"
          disabled={state.busy}
          onClick={() => run(() => service.advance(job.jobId, step.action, tracking.lastFix))}
          className="mt-5 w-full rounded-xl bg-brand-700 py-4 text-lg font-bold text-white shadow-lg disabled:opacity-60"
        >
          {state.busy ? 'Saving…' : step.label}
        </button>
      ) : null}
      {job.status === 'ARRIVED_DROPOFF' ? (
        <Link to={`/jobs/${job.jobId}/deliver`} className="mt-5 block w-full rounded-xl bg-brand-700 py-4 text-center text-lg font-bold text-white shadow-lg">
          Record proof of delivery
        </Link>
      ) : null}

      {canFail(job.status) ? (
        failing ? (
          <section className="mt-5 grid gap-2" aria-label="Report a failed delivery">
            <label className="grid gap-1 text-sm font-medium">
              What went wrong? (PharmaLink operations sees this)
              <textarea className="rounded-lg border border-slate-300 px-3 py-2 text-base" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setFailing(false)} className="rounded-lg border border-slate-300 py-2.5 font-semibold">Back</button>
              <button
                type="button"
                disabled={state.busy || !reason.trim()}
                onClick={() => run(() => service.fail(job.jobId, reason, tracking.lastFix))}
                className="rounded-lg bg-danger py-2.5 font-semibold text-white disabled:opacity-50"
              >
                Report failed
              </button>
            </div>
          </section>
        ) : (
          <button type="button" onClick={() => setFailing(true)} className="mt-4 w-full rounded-lg border border-slate-300 py-2.5 text-sm font-semibold text-danger">
            I cannot deliver this
          </button>
        )
      ) : null}
    </main>
    </div>
  )
}
