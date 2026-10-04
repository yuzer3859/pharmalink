// Mock data for the PharmaLink prototype.

export const categories = [
  { id: 'prescription', label: 'Prescription', icon: 'FileText' },
  { id: 'otc', label: 'Over the counter', icon: 'Pill' },
  { id: 'wellness', label: 'Wellness', icon: 'HeartPulse' },
  { id: 'baby', label: 'Mother & Baby', icon: 'Baby' },
  { id: 'devices', label: 'Devices', icon: 'Stethoscope' },
  { id: 'skincare', label: 'Personal care', icon: 'Sparkles' },
]

export const medicines = [
  { id: 'm1', name: 'Amoxicillin 500mg', brand: 'Cadila', form: 'Capsule · 21 caps', price: 240, rx: true, rating: 4.8, reviews: 312, stock: 'In stock', pharmacy: 'Kenema Pharmacy', distance: '1.2 km', tag: 'Antibiotic' },
  { id: 'm2', name: 'Paracetamol 500mg', brand: 'APF', form: 'Tablet · 20 tabs', price: 60, rx: false, rating: 4.9, reviews: 1204, stock: 'In stock', pharmacy: 'Bole Pharma', distance: '0.8 km', tag: 'Pain relief' },
  { id: 'm3', name: 'Vitamin D3 2000IU', brand: 'Nature Made', form: 'Softgel · 60 caps', price: 520, rx: false, rating: 4.7, reviews: 208, stock: 'Low stock', pharmacy: 'Gerji Health', distance: '2.4 km', tag: 'Supplement' },
  { id: 'm4', name: 'Metformin 850mg', brand: 'Merck', form: 'Tablet · 30 tabs', price: 310, rx: true, rating: 4.6, reviews: 96, stock: 'In stock', pharmacy: 'Kenema Pharmacy', distance: '1.2 km', tag: 'Diabetes' },
  { id: 'm5', name: 'Salbutamol Inhaler', brand: 'Ventolin', form: 'Inhaler · 200 doses', price: 480, rx: true, rating: 4.9, reviews: 154, stock: 'In stock', pharmacy: 'Meskel Pharma', distance: '3.1 km', tag: 'Respiratory' },
  { id: 'm6', name: 'ORS Sachets', brand: 'WHO Formula', form: 'Powder · 10 sachets', price: 95, rx: false, rating: 4.8, reviews: 421, stock: 'In stock', pharmacy: 'Bole Pharma', distance: '0.8 km', tag: 'Hydration' },
  { id: 'm7', name: 'Omeprazole 20mg', brand: 'AstraZeneca', form: 'Capsule · 14 caps', price: 180, rx: false, rating: 4.5, reviews: 88, stock: 'In stock', pharmacy: 'Gerji Health', distance: '2.4 km', tag: 'Digestive' },
  { id: 'm8', name: 'Cetirizine 10mg', brand: 'Zyrtec', form: 'Tablet · 10 tabs', price: 75, rx: false, rating: 4.7, reviews: 260, stock: 'In stock', pharmacy: 'Meskel Pharma', distance: '3.1 km', tag: 'Allergy' },
]

export const doctors = [
  { id: 'd1', name: 'Dr. Selamawit Bekele', specialty: 'Cardiologist', hospital: 'Nordic Medical Centre', experience: 12, fee: 900, rating: 4.9, reviews: 214, next: 'Today 3:30 PM', langs: ['Amharic', 'English'], verified: true },
  { id: 'd2', name: 'Dr. Yonas Tadesse', specialty: 'Dermatologist', hospital: 'Bethel Teaching Hospital', experience: 8, fee: 700, rating: 4.8, reviews: 176, next: 'Tomorrow 10:00 AM', langs: ['Amharic', 'English', 'Afaan Oromoo'], verified: true },
  { id: 'd3', name: 'Dr. Hanna Girma', specialty: 'Pediatrician', hospital: 'St. Gabriel Hospital', experience: 15, fee: 800, rating: 5.0, reviews: 402, next: 'Today 5:00 PM', langs: ['Amharic', 'English'], verified: true },
  { id: 'd4', name: 'Dr. Abel Mengistu', specialty: 'General Physician', hospital: 'Kadisco General Hospital', experience: 6, fee: 500, rating: 4.7, reviews: 129, next: 'Today 2:00 PM', langs: ['Amharic', 'English'], verified: true },
]

export const diagnostics = [
  { id: 't1', name: 'Complete Blood Count (CBC)', center: 'Pioneer Diagnostic Lab', price: 350, turnaround: '4 hrs', rating: 4.8, prep: 'No fasting required', type: 'Lab test' },
  { id: 't2', name: 'Lipid Profile', center: 'Pioneer Diagnostic Lab', price: 520, turnaround: 'Same day', rating: 4.7, prep: '12 hrs fasting', type: 'Lab test' },
  { id: 't3', name: 'Abdominal Ultrasound', center: 'Bethzatha Imaging', price: 1200, turnaround: '1 hr', rating: 4.9, prep: 'Full bladder', type: 'Imaging' },
  { id: 't4', name: 'Chest X-Ray', center: 'Bethzatha Imaging', price: 650, turnaround: '30 min', rating: 4.6, prep: 'No preparation', type: 'Imaging' },
]

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
