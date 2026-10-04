import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Search, Pill, SlidersHorizontal, MapPin, Upload, ShieldCheck, Plus, Store } from 'lucide-react'
import { Button, Card, Badge, Input, Rating, Segmented, IconTile } from '../components/ui'
import { medicines } from '../data/mock'
import { formatETB } from '../lib/utils'

const filters = ['All', 'Prescription', 'OTC', 'In stock', 'Nearby']

export default function Medicines() {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('All')
  const [sort, setSort] = useState('Relevance')

  const results = useMemo(() => {
    let list = medicines.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()))
    if (filter === 'Prescription') list = list.filter((m) => m.rx)
    if (filter === 'OTC') list = list.filter((m) => !m.rx)
    if (filter === 'In stock') list = list.filter((m) => m.stock === 'In stock')
    if (sort === 'Price: low to high') list = [...list].sort((a, b) => a.price - b.price)
    if (sort === 'Rating') list = [...list].sort((a, b) => b.rating - a.rating)
    return list
  }, [q, filter, sort])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-h1 text-fg">Medicines & health products</h1>
        <p className="text-body text-muted">Ordering for <span className="font-semibold text-fg">Bole, Addis Ababa</span> · prices from verified pharmacies.</p>
      </div>

      {/* Rx upload */}
      <Card className="flex items-center gap-4 border-dashed p-4 sm:p-5">
        <IconTile icon={Upload} size={48} tone="accent" />
        <div className="flex-1">
          <p className="text-body-lg font-semibold text-fg">Upload a prescription</p>
          <p className="text-caption text-muted">JPG, PNG or PDF · encrypted & reviewed by a licensed pharmacist.</p>
        </div>
        <Button variant="soft" size="sm"><Upload className="h-4 w-4" /> Upload</Button>
      </Card>

      {/* Search + controls */}
      <div className="sticky top-16 z-20 -mx-4 space-y-3 bg-bg/80 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Amoxicillin, Paracetamol…" />
          <Button variant="secondary" size="md" className="shrink-0"><SlidersHorizontal className="h-4 w-4" /> Filters</Button>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                'whitespace-nowrap rounded-full border px-3.5 py-1.5 text-caption font-semibold transition-colors ' +
                (filter === f
                  ? 'border-brand-500 bg-brand-500/12 text-brand-700 dark:text-brand-300'
                  : 'border-border bg-surface text-muted hover:text-fg')
              }
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Results header */}
      <div className="flex items-center justify-between">
        <p className="text-caption text-muted"><span className="font-semibold text-fg">{results.length}</span> results</p>
        <Segmented options={['Relevance', 'Price: low to high', 'Rating']} value={sort} onChange={setSort} className="hidden sm:inline-flex" />
      </div>

      {/* Grid */}
      <motion.div
        layout
        className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4"
      >
        {results.map((m) => (
          <motion.div layout key={m.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <Card interactive className="flex h-full flex-col p-4">
              <div className="mb-3 flex items-start justify-between">
                <div className="grid h-16 w-16 place-items-center rounded-2xl bg-surface-2 text-brand-500">
                  <Pill className="h-7 w-7" />
                </div>
                {m.rx ? <Badge tone="warning">Rx required</Badge> : <Badge tone="success">OTC</Badge>}
              </div>
              <p className="text-body-lg font-semibold text-fg">{m.name}</p>
              <p className="text-caption text-muted">{m.brand} · {m.form}</p>
              <div className="mt-1.5"><Rating value={m.rating} count={m.reviews} /></div>

              <div className="mt-3 flex items-center gap-1.5 text-caption text-muted">
                <Store className="h-3.5 w-3.5" /> {m.pharmacy}
                <span className="text-subtle">·</span>
                <MapPin className="h-3.5 w-3.5" /> {m.distance}
              </div>
              <div className="mt-1">
                <Badge tone={m.stock === 'In stock' ? 'success' : 'warning'} dot>{m.stock}</Badge>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                <div>
                  <span className="text-h3 font-bold text-fg">{formatETB(m.price)}</span>
                </div>
                <Button size="sm"><Plus className="h-4 w-4" /> Add</Button>
              </div>
            </Card>
          </motion.div>
        ))}
      </motion.div>

      <div className="flex items-center justify-center gap-2 rounded-2xl bg-brand-500/8 p-4 text-caption text-muted">
        <ShieldCheck className="h-4 w-4 text-brand-500" />
        Prescription items require pharmacist verification before dispatch.
      </div>
    </div>
  )
}
