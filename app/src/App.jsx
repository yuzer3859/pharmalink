import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import Layout from './components/Layout'
import Home from './pages/Home'
import Medicines from './pages/Medicines'
import Doctors from './pages/Doctors'
import Diagnostics from './pages/Diagnostics'
import Tracking from './pages/Tracking'
import Checkout from './pages/Checkout'
import DesignSystem from './pages/DesignSystem'

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
          <Route path="/doctors" element={<Page><Doctors /></Page>} />
          <Route path="/diagnostics" element={<Page><Diagnostics /></Page>} />
          <Route path="/tracking" element={<Page><Tracking /></Page>} />
          <Route path="/checkout" element={<Page><Checkout /></Page>} />
          <Route path="/design-system" element={<Page><DesignSystem /></Page>} />
        </Routes>
      </AnimatePresence>
    </Layout>
  )
}
