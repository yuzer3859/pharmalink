// Mock data for the PharmaLink prototype's tracking and checkout screens (removed in Works 100 and 102).
// Medicines and categories come from the backend Catalog API (Work 64), never from here.

export const cart = [
  { id: 'm2', name: 'Paracetamol 500mg', form: 'Tablet · 20 tabs', qty: 2, price: 60, pharmacy: 'Bole Pharma' },
  { id: 'm6', name: 'ORS Sachets', form: 'Powder · 10 sachets', qty: 1, price: 95, pharmacy: 'Bole Pharma' },
  { id: 'm3', name: 'Vitamin D3 2000IU', form: 'Softgel · 60 caps', qty: 1, price: 520, pharmacy: 'Gerji Health' },
]

export const trackingSteps = [
  { id: 1, title: 'Order confirmed', desc: 'Bole Pharma accepted your order', time: '2:04 PM', done: true },
  { id: 2, title: 'Prescription verified', desc: 'Licensed pharmacist approved Rx', time: '2:11 PM', done: true },
  { id: 3, title: 'Preparing your order', desc: 'Items packed & sealed', time: '2:20 PM', done: true },
  { id: 4, title: 'Out for delivery', desc: 'Dawit is on the way', time: '2:36 PM', done: false, active: true },
  { id: 5, title: 'Delivered', desc: 'Estimated 2:55 PM', time: '—', done: false },
]
