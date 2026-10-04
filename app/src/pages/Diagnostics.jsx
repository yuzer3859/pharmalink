import { useState } from 'react'
import { motion } from 'framer-motion'
import { Search, FlaskConical, Scan, Clock, Info, MapPin, CalendarDays, Home } from 'lucide-react'
import { Button, Card, Badge, Input, Rating, IconTile } from '../components/ui'
import { diagnostics } from '../data/mock'
import { formatETB } from '../lib/utils'

const types = ['All', 'Lab test', 'Imaging', 'Health packages']

const packages = [
  { name: 'Full Body Checkup', tests: 42, price: 2400, tone: 'brand' },
  { name: 'Diabetes Care Panel', tests: 8, price: 950, tone: 'accent' },
  { name: 'Heart Health Screen', tests: 12, price: 1600, tone: 'violet' },
]

export default function Diagnostics() {
  const [type, setType] = useState('All')
  const list = diagnostics.filter((t) => type === 'All' || t.type === type)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-h1 text-fg">Lab tests & diagnostics</h1>
        <p className="text-body text-muted">Book tests and scans at verified centers — or request home sample collection.</p>
      </div>

      <Card className="flex items-center gap-4 p-4 sm:p-5">
        <IconTile icon={Home} size={48} tone="success" />
        <div className="flex-1">
          <p className="text-body-lg font-semibold text-fg">Home sample collection</p>
          <p className="text-caption text-muted">A trained phlebotomist visits you. Available in Addis Ababa.</p>
        </div>
        <Button variant="soft" size="sm">Book at home</Button>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input icon={Search} placeholder="Search tests, scans, or packages…" />
        <Button variant="secondary" size="md" className="shrink-0"><MapPin className="h-4 w-4" /> Nearby centers</Button>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {types.map((t) => (
          <button key={t} onClick={() => setType(t)}
            className={'whitespace-nowrap rounded-full border px-3.5 py-1.5 text-caption font-semibold transition-colors ' +
              (type === t ? 'border-brand-500 bg-brand-500/12 text-brand-700 dark:text-brand-300' : 'border-border bg-surface text-muted hover:text-fg')}>
            {t}
          </button>
        ))}
      </div>

      {/* Packages */}
      {(type === 'All' || type === 'Health packages') && (
        <div>
          <h2 className="mb-3 text-h3 text-fg">Health screening packages</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {packages.map((p) => (
              <Card key={p.name} interactive className="relative overflow-hidden p-5">
                <IconTile icon={FlaskConical} tone={p.tone} size={44} />
                <p className="mt-3 text-body-lg font-semibold text-fg">{p.name}</p>
                <p className="text-caption text-muted">{p.tests} tests included</p>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-h3 font-bold text-fg">{formatETB(p.price)}</span>
                  <Button size="sm" variant="soft">Book</Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Individual tests */}
      <div>
        <h2 className="mb-3 text-h3 text-fg">Tests & scans</h2>
        <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
          {list.map((t) => (
            <motion.div key={t.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <Card className="flex flex-col gap-3 p-5">
                <div className="flex items-start gap-4">
                  <IconTile icon={t.type === 'Imaging' ? Scan : FlaskConical} tone={t.type === 'Imaging' ? 'violet' : 'brand'} size={48} />
                  <div className="min-w-0 flex-1">
                    <p className="text-body-lg font-semibold text-fg">{t.name}</p>
                    <p className="text-caption text-muted">{t.center}</p>
                    <div className="mt-1"><Rating value={t.rating} /></div>
                  </div>
                  <Badge tone="neutral">{t.type}</Badge>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Badge tone="info"><Clock className="h-3.5 w-3.5" /> Results in {t.turnaround}</Badge>
                  <Badge tone="warning"><Info className="h-3.5 w-3.5" /> {t.prep}</Badge>
                </div>

                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-h3 font-bold text-fg">{formatETB(t.price)}</span>
                  <Button size="md"><CalendarDays className="h-4 w-4" /> Book slot</Button>
                </div>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  )
}
