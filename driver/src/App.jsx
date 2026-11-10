import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import ActiveJob from './pages/ActiveJob'
import Deliver from './pages/Deliver'
import Home from './pages/Home'
import SignIn from './pages/SignIn'

/** Signed out: only sign-in. Signed in: the driver's screens. */
export default function App() {
  const { status } = useAuth()
  if (status === 'initializing') {
    return (
      <p className="p-6 text-sm text-slate-600" role="status">
        Loading…
      </p>
    )
  }
  if (status !== 'signedIn') {
    return (
      <Routes>
        <Route path="*" element={<SignIn />} />
      </Routes>
    )
  }
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/jobs/:jobId" element={<ActiveJob />} />
      <Route path="/jobs/:jobId/deliver" element={<Deliver />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
