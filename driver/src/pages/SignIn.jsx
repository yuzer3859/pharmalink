import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'

/** Work 118: e-mail and password sign-in (SMS is not available). Non-driver accounts are refused clearly. */
export default function SignIn() {
  const { login, expired } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState({ busy: false, error: null })

  async function submit(e) {
    e.preventDefault()
    setState({ busy: true, error: null })
    try {
      await login({ email, password })
    } catch (error) {
      const message =
        error?.code === 'AUTH_INVALID_CREDENTIALS' || error?.status === 401
          ? 'That e-mail and password do not match a PharmaLink account.'
          : error?.message || 'Signing in failed. Try again.'
      setState({ busy: false, error: message })
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-sm flex-col justify-center px-5 py-10">
      <h1 className="text-2xl font-bold text-brand-800">PharmaLink Driver</h1>
      <p className="mt-1 text-sm text-slate-600">Sign in with the account PharmaLink set up for your deliveries.</p>
      {expired ? (
        <p className="mt-4 rounded-lg bg-warning-soft px-3 py-2 text-sm" role="status">
          Your session ended. Please sign in again.
        </p>
      ) : null}
      <form onSubmit={submit} className="mt-6 grid gap-3" aria-label="Sign in">
        <label className="grid gap-1 text-sm font-medium">
          E-mail
          <input className="rounded-lg border border-slate-300 px-3 py-2.5 text-base" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Password
          <input className="rounded-lg border border-slate-300 px-3 py-2.5 text-base" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {state.error ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {state.error}
          </p>
        ) : null}
        <button type="submit" disabled={state.busy} className="mt-2 rounded-lg bg-brand-700 px-4 py-3 font-semibold text-white disabled:opacity-60">
          {state.busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
