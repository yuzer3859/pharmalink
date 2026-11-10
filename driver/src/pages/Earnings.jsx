import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { birr } from '../jobs/driverService'
import { createMoneyService, EARNING_STATUS_TEXT, earningTotals } from '../money/money'

/** Work 123: what the driver has earned per delivery, and how much is still to be paid. */
export default function Earnings() {
  const { request } = useAuth()
  const service = useMemo(() => createMoneyService(request), [request])
  const [state, setState] = useState({ data: null, error: null })

  useEffect(() => {
    let active = true
    service
      .earnings()
      .then((data) => active && setState({ data, error: null }))
      .catch((error) => active && setState({ data: null, error }))
    return () => {
      active = false
    }
  }, [service])

  const items = state.data?.items ?? []
  const totals = earningTotals(items)
  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <Link to="/" className="text-sm font-semibold text-brand-700">← Home</Link>
      <h1 className="mt-2 text-xl font-bold">Earnings</h1>
      {state.error ? <p role="alert" className="mt-3 text-sm text-danger">{state.error.message || 'Earnings could not be loaded.'}</p> : null}
      {!state.data && !state.error ? <p role="status" className="mt-3 text-sm text-slate-600">Loading…</p> : null}
      {state.data ? (
        <>
          <section className="mt-4 grid grid-cols-2 gap-2" aria-label="Totals">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-500">To be paid</p>
              <p className="text-lg font-semibold">{birr(totals.toBePaid)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-500">Paid</p>
              <p className="text-lg font-semibold">{birr(totals.paid)}</p>
            </div>
          </section>
          <ul className="mt-4 grid gap-2" aria-label="Earnings per delivery">
            {items.map((e) => (
              <li key={e.id} className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                <div className="flex justify-between">
                  <span>{new Date(e.accruedAt).toLocaleDateString()}</span>
                  <span className="font-semibold">{birr(e.total)}</span>
                </div>
                <p className="text-xs text-slate-500">{EARNING_STATUS_TEXT[e.status] ?? e.status}</p>
              </li>
            ))}
            {items.length === 0 ? <li className="text-sm text-slate-500">No earnings yet. They appear once a delivery is completed.</li> : null}
          </ul>
        </>
      ) : null}
    </main>
  )
}
