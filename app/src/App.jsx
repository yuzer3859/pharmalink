import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import Layout from './components/Layout'
import Home from './pages/Home'
import Medicines from './pages/Medicines'
import MedicineDetail from './pages/MedicineDetail'
import Doctors from './pages/Doctors'
import Diagnostics from './pages/Diagnostics'
import Tracking from './pages/Tracking'
import Checkout from './pages/Checkout'
import DesignSystem from './pages/DesignSystem'
import Register from './pages/auth/Register'
import VerifyEmail from './pages/auth/VerifyEmail'
import Login from './pages/auth/Login'
import ForgotPassword from './pages/auth/ForgotPassword'
import ResetPassword from './pages/auth/ResetPassword'
import Account from './pages/auth/Account'
import { RequireCustomer } from './auth/AuthContext'

function Page({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

export default function App() {
  const location = useLocation()
  return (
    <Layout>
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<Page><Home /></Page>} />
          <Route path="/medicines" element={<Page><Medicines /></Page>} />
          <Route path="/medicines/:id" element={<Page><MedicineDetail /></Page>} />
          <Route path="/doctors" element={<Page><Doctors /></Page>} />
          <Route path="/diagnostics" element={<Page><Diagnostics /></Page>} />
          <Route path="/tracking" element={<Page><Tracking /></Page>} />
          <Route path="/checkout" element={<Page><Checkout /></Page>} />
          <Route path="/design-system" element={<Page><DesignSystem /></Page>} />
          <Route path="/register" element={<Page><Register /></Page>} />
          <Route path="/verify-email" element={<Page><VerifyEmail /></Page>} />
          <Route path="/login" element={<Page><Login /></Page>} />
          <Route path="/forgot-password" element={<Page><ForgotPassword /></Page>} />
          <Route path="/reset-password" element={<Page><ResetPassword /></Page>} />
          <Route path="/account" element={<Page><RequireCustomer><Account /></RequireCustomer></Page>} />
        </Routes>
      </AnimatePresence>
    </Layout>
  )
}
