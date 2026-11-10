import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { birr } from '../jobs/driverService'
import { CASH_STATUS_TEXT, cashTotals, createMoneyService } from '../money/money'

/**
 * Work 123: the cash the driver collected on COD deliveries, and whether it has reached PharmaLink.
 * The handover itself is recorded by PharmaLink finance when they receive the cash.
 */
export default function Cash() {
  const { request } = useAuth()
  const service = useMemo(() => createMoneyService(request), [request])
  const [state, setState] = useState({ rows: null, error: null })

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const page = await service.deliveredJobs()
        const cod = (page?.items ?? []).filter((j) => j.isCod)
        const rows = await Promise.all(
          cod.map(async (job) => {
            try {
              return { job, collection: await service.cashCollection(job.jobId) }
            } catch {
              return { job, collection: null }
            }
          }),
        )
        if (active) setState({ rows, error: null })
      } catch (error) {
        if (active) setState({ rows: null, error })
      }
    })()
    return () => {
      active = false
    }
  }, [service])

  const totals = cashTotals(state.rows?.map((r) => r.collection))
  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <Link to="/" className="text-sm font-semibold text-brand-700">← Home</Link>
      <h1 className="mt-2 text-xl font-bold">Cash collected</h1>
      {state.error ? <p role="alert" className="mt-3 text-sm text-danger">{state.error.message || 'Cash could not be loaded.'}</p> : null}
      {!state.rows && !state.error ? <p role="status" className="mt-3 text-sm text-slate-600">Loading…</p> : null}
      {state.rows ? (
        <>
          <section className="mt-4 rounded-xl border border-warning bg-warning-soft p-4" aria-label="Cash with you">
            <p className="text-sm">Cash with you, to hand to PharmaLink</p>
            <p className="text-2xl font-bold">{birr(totals.withYou)}</p>
            <p className="mt-1 text-xs text-slate-600">Handed over so far: {birr(totals.handedOver)}</p>
          </section>
          <ul className="mt-4 grid gap-2" aria-label="Cash per delivery">
            {state.rows.map(({ job, collection }) => (
              <li key={job.jobId} className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                <div className="flex justify-between">
                  <span>{job.dropoffAddress ?? 'Delivery'}</span>
                  <span className="font-semibold">{birr(collection?.collectedAmount ?? job.codAmount ?? 0)}</span>
                </div>
                <p className="text-xs text-slate-500">
                  {collection ? CASH_STATUS_TEXT[collection.status] ?? collection.status : 'No collection recorded'}
                  {collection?.hasDiscrepancy ? ' · differs from the amount due' : ''}
                </p>
              </li>
            ))}
            {state.rows.length === 0 ? <li className="text-sm text-slate-500">No cash-on-delivery deliveries yet.</li> : null}
          </ul>
        </>
      ) : null}
    </main>
  )
}
