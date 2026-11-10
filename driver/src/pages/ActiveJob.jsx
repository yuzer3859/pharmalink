import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { birr } from '../jobs/driverService'
import { useDriverJobs, useDriverService } from '../jobs/hooks'
import { canFail, destination, mapsLink, nextStep, sharesLiveLocation, STATUS_TEXT, stepErrorMessage } from '../jobs/jobSteps'
import { useJobTracking } from '../jobs/useJobTracking'

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

  const step = job ? nextStep(job.status) : null
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

  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <Link to="/" className="text-sm font-semibold text-brand-700">← All deliveries</Link>
      <h1 className="mt-2 text-xl font-bold">{STATUS_TEXT[job.status] ?? job.status}</h1>

      {to ? (
        <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4" aria-label="Destination">
          <p className="text-sm text-slate-500">{to.label}</p>
          <p className="font-semibold">{to.address ?? 'Address not given'}</p>
          {mapsLink(to.address) ? (
            <a href={mapsLink(to.address)} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm font-semibold text-brand-700">
              Open in maps
            </a>
          ) : null}
        </section>
      ) : null}

      {job.isCod ? (
        <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-sm font-semibold">Collect {birr(job.codAmount ?? 0)} in cash from the customer.</p>
      ) : null}
      {job.isColdChain ? <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-800">Keep this order cold.</p> : null}
      {live && TRACKING_TEXT[tracking.status] ? <p className="mt-3 text-xs text-slate-600" role="status">{TRACKING_TEXT[tracking.status]}</p> : null}

      {state.error ? <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p> : null}

      {step ? (
        <button
          type="button"
          disabled={state.busy}
          onClick={() => run(() => service.advance(job.jobId, step.action, tracking.lastFix))}
          className="mt-5 w-full rounded-lg bg-brand-700 py-3.5 text-lg font-semibold text-white disabled:opacity-60"
        >
          {state.busy ? 'Saving…' : step.label}
        </button>
      ) : null}
      {job.status === 'ARRIVED_DROPOFF' ? (
        <Link to={`/jobs/${job.jobId}/deliver`} className="mt-5 block w-full rounded-lg bg-brand-700 py-3.5 text-center text-lg font-semibold text-white">
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
  )
}
