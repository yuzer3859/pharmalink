import { useAuth } from '../auth/AuthContext'

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

/**
 * Work 118: the signed-in driver's home. Availability, offers and the active job arrive in the next
 * Works (119–120); this shows who is signed in and whether they may drive.
 */
export default function Home() {
  const { driver, logout } = useAuth()
  const profile = driver?.profile
  const notVerified = verificationText(profile?.verification)
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

      {notVerified ? (
        <p role="status" className="mt-5 rounded-lg bg-warning-soft px-3 py-2 text-sm">
          {notVerified}
        </p>
      ) : (
        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-label="Status">
          <p className="text-sm text-slate-600">You are</p>
          <p className="text-lg font-semibold">{profile?.availability === 'ONLINE' ? 'Online' : 'Offline'}</p>
          {profile?.vehicle ? (
            <p className="mt-1 text-sm text-slate-600">
              {profile.vehicle.type.toLowerCase()}
              {profile.vehicle.plateNumber ? ` · ${profile.vehicle.plateNumber}` : ''}
            </p>
          ) : null}
        </section>
      )}
    </main>
  )
}
