import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError } from '../api/apiClient'
import SignaturePad from '../delivery/SignaturePad'
import { buildProof, cashToSantim, deliverErrorMessage, proofPlan, shrinkPhoto } from '../delivery/proof'
import { birr } from '../jobs/driverService'
import { useDriverJobs, useDriverService } from '../jobs/hooks'

const alreadyDone = (error) => error instanceof ApiError && error.status === 409

/**
 * Work 122: at the customer's door. For a COD job, the cash collected is recorded first (the
 * pharmacy is paid only once that cash reaches PharmaLink). Then the proof the job's rules demand:
 * the customer's confirmation, or their signature or a photo. Then the delivery. Each step is safe to
 * retry: a collection or proof already stored is not stored twice.
 */
export default function Deliver({ shrink = shrinkPhoto }) {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const service = useDriverService()
  const jobs = useDriverJobs(true)
  const job = jobs.data?.items?.find((j) => j.jobId === jobId) ?? null
  const plan = proofPlan(job?.rules)

  const [cash, setCash] = useState('')
  const [recipientName, setRecipientName] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [signature, setSignature] = useState(null)
  const [photo, setPhoto] = useState(null)
  const [photoState, setPhotoState] = useState({ busy: false, error: null })
  const [state, setState] = useState({ busy: false, error: null, step: null })

  if (!jobs.data && !jobs.error) return <p className="p-6 text-sm text-slate-600" role="status">Loading the job…</p>
  if (!job || job.status !== 'ARRIVED_DROPOFF') {
    return (
      <main className="mx-auto max-w-md px-5 py-6">
        <p className="text-sm text-slate-600">{job ? 'Arrive at the customer first.' : 'This job is not one of your deliveries any more.'}</p>
        <Link to={job ? `/jobs/${job.jobId}` : '/'} className="mt-3 inline-block font-semibold text-brand-700">Back</Link>
      </main>
    )
  }

  const due = job.codAmount ?? 0
  const cashSantim = job.isCod ? (cash === '' ? due : cashToSantim(cash)) : null
  const cashProblem = job.isCod && cashSantim === null ? 'Enter the cash you received, in birr.' : null
  const exactProblem = job.isCod && job.rules?.codExactAmountRequired && cashSantim !== due ? `PharmaLink needs the exact amount: ${birr(due)}.` : null
  const { proof, problem } = buildProof({ plan, recipientName, recipientConfirmed: confirmed, signature, photo })
  const blocking = cashProblem ?? exactProblem ?? problem

  async function takePhoto(file) {
    if (!file) return
    setPhotoState({ busy: true, error: null })
    try {
      setPhoto(await shrink(file))
      setPhotoState({ busy: false, error: null })
    } catch (error) {
      setPhoto(null)
      setPhotoState({ busy: false, error: error?.message || 'The picture could not be used.' })
    }
  }

  async function submit() {
    setState({ busy: true, error: null, step: null })
    try {
      if (job.isCod) {
        setState((s) => ({ ...s, step: 'Recording the cash…' }))
        try {
          await service.recordCash(job.jobId, cashSantim)
        } catch (error) {
          if (!alreadyDone(error)) throw error
        }
      }
      setState((s) => ({ ...s, step: 'Saving the proof…' }))
      try {
        await service.captureProof(job.jobId, proof)
      } catch (error) {
        if (!alreadyDone(error)) throw error
      }
      setState((s) => ({ ...s, step: 'Completing the delivery…' }))
      await service.deliver(job.jobId)
      navigate('/', { replace: true, state: { delivered: job.jobId } })
    } catch (error) {
      setState({ busy: false, error: deliverErrorMessage(error), step: null })
      jobs.reload()
    }
  }

  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <Link to={`/jobs/${job.jobId}`} className="text-sm font-semibold text-brand-700">← Back to the job</Link>
      <h1 className="mt-2 text-xl font-bold">Hand over the order</h1>
      <p className="text-sm text-slate-600">{job.dropoffAddress}</p>

      {job.isCod ? (
        <section className="mt-4 rounded-xl border border-warning bg-warning-soft p-4" aria-label="Cash on delivery">
          <p className="font-semibold">Collect {birr(due)} in cash</p>
          <label className="mt-2 grid gap-1 text-sm font-medium">
            Cash received (birr)
            <input className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-base" inputMode="decimal" placeholder={(due / 100).toFixed(2)} value={cash} onChange={(e) => setCash(e.target.value)} />
          </label>
          <p className="mt-1 text-xs text-slate-600">Hand the cash to PharmaLink as instructed; the pharmacy is paid once it arrives.</p>
        </section>
      ) : null}

      <section className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-white p-4" aria-label="Proof of delivery">
        <p className="font-semibold">
          {plan.needsArtifact ? 'Proof: the customer’s signature or a photo' : 'Proof: the customer confirms they received it'}
        </p>
        <label className="grid gap-1 text-sm font-medium">
          Received by (name)
          <input className="rounded-lg border border-slate-300 px-3 py-2 text-base" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} maxLength={120} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          The customer confirms they received the order
        </label>

        <details open={plan.needsArtifact} className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-semibold">{plan.needsArtifact ? 'Signature or photo (required)' : 'Add a signature or photo (optional)'}</summary>
          <div className="mt-3 grid gap-3">
            <SignaturePad onChange={setSignature} />
            {signature ? <p className="text-xs text-success">Signature added.</p> : null}
            <label className="grid gap-1 text-sm font-medium">
              Or take a photo of the handover
              <input type="file" accept="image/*" capture="environment" onChange={(e) => takePhoto(e.target.files?.[0])} />
            </label>
            {photoState.busy ? <p className="text-xs text-slate-600" role="status">Preparing the photo…</p> : null}
            {photo ? <p className="text-xs text-success">Photo added.</p> : null}
            {photoState.error ? <p role="alert" className="text-xs text-danger">{photoState.error}</p> : null}
          </div>
        </details>
      </section>

      {blocking ? <p className="mt-3 text-sm text-slate-600">{blocking}</p> : null}
      {state.error ? <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p> : null}
      {state.step ? <p role="status" className="mt-3 text-sm text-slate-600">{state.step}</p> : null}

      <button
        type="button"
        disabled={state.busy || !!blocking}
        onClick={submit}
        className="mt-5 w-full rounded-lg bg-brand-700 py-3.5 text-lg font-semibold text-white disabled:opacity-50"
      >
        {state.busy ? 'Please wait…' : 'Complete delivery'}
      </button>
    </main>
  )
}
