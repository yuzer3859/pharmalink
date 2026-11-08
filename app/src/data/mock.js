// Mock data for the PharmaLink prototype's tracking screen (removed in Work 102).
// Medicines and categories come from the backend Catalog API (Work 64), never from here.

export const trackingSteps = [
  { id: 1, title: 'Order confirmed', desc: 'Bole Pharma accepted your order', time: '2:04 PM', done: true },
  { id: 2, title: 'Prescription verified', desc: 'Licensed pharmacist approved Rx', time: '2:11 PM', done: true },
  { id: 3, title: 'Preparing your order', desc: 'Items packed & sealed', time: '2:20 PM', done: true },
  { id: 4, title: 'Out for delivery', desc: 'Dawit is on the way', time: '2:36 PM', done: false, active: true },
  { id: 5, title: 'Delivered', desc: 'Estimated 2:55 PM', time: '—', done: false },
]
