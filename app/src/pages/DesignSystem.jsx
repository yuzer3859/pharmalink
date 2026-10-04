import {
  Pill, Stethoscope, FlaskConical, HeartPulse, Baby, Sparkles, Truck, ShieldCheck,
  Bell, Search, MapPin, Phone, CalendarDays, Upload, Star, Home, Activity, Syringe,
} from 'lucide-react'
import { Button, Card, Badge, Input, Avatar, Rating, IconTile, Segmented, CheckItem, Skeleton, SectionHead } from '../components/ui'
import { useState } from 'react'

function Swatch({ name, className, hex }) {
  return (
    <div>
      <div className={'h-16 w-full rounded-xl border border-border ' + className} />
      <p className="mt-1.5 text-caption font-semibold text-fg">{name}</p>
      {hex && <p className="text-[11px] text-subtle">{hex}</p>}
    </div>
  )
}

const brandScale = [
  ['50', 'bg-brand-50', '#eafcf7'], ['100', 'bg-brand-100', '#cdf6ec'], ['200', 'bg-brand-200', '#9eecdb'],
  ['300', 'bg-brand-300', '#66dbc6'], ['400', 'bg-brand-400', '#33c2ac'], ['500', 'bg-brand-500', '#14b8a6'],
  ['600', 'bg-brand-600', '#0d9488'], ['700', 'bg-brand-700', '#0f766e'], ['800', 'bg-brand-800', '#115e59'], ['900', 'bg-brand-900', '#134e4a'],
]

const icons = [Pill, Stethoscope, FlaskConical, HeartPulse, Baby, Sparkles, Truck, ShieldCheck, Bell, Search, MapPin, Phone, CalendarDays, Upload, Star, Home, Activity, Syringe]

export default function DesignSystem() {
  const [seg, setSeg] = useState('Design')
  return (
    <div className="space-y-12">
      <header>
        <Badge tone="brand" dot>PharmaLink Design System v1.0</Badge>
        <h1 className="mt-3 font-display text-display font-extrabold tracking-tight text-fg">The design language</h1>
        <p className="mt-2 max-w-2xl text-body-lg text-muted">
          A calm, trustworthy, healthcare-first system inspired by Apple's clarity, Stripe's precision,
          and Material's structure. Built for accessibility, dark mode, and scale.
        </p>
      </header>

      {/* Principles */}
      <section>
        <SectionHead title="Principles" subtitle="Every screen is measured against these." />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Simplicity', 'One primary action per screen. Remove before adding.'],
            ['Trust', 'Verification, transparency, and privacy made visible.'],
            ['Accessibility', 'WCAG AA contrast, 44px targets, full keyboard support.'],
            ['Warmth', 'Human, reassuring tone for anxious health moments.'],
          ].map(([t, d]) => (
            <Card key={t} className="p-5">
              <p className="text-body-lg font-semibold text-fg">{t}</p>
              <p className="mt-1 text-caption text-muted">{d}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Typography */}
      <section>
        <SectionHead title="Typography" subtitle="Plus Jakarta Sans for display · Inter for UI & body." />
        <Card className="divide-y divide-border p-0">
          {[
            ['Display / 800', 'font-display text-display', 'Healthcare, delivered'],
            ['Heading 1 / 700', 'font-display text-h1', 'Find a doctor near you'],
            ['Heading 2 / 700', 'font-display text-h2', 'Popular right now'],
            ['Heading 3 / 600', 'text-h3 font-semibold', 'Order summary'],
            ['Body / 400', 'text-body-lg', 'Upload a prescription and we securely match a licensed pharmacy.'],
            ['Caption / 400', 'text-caption', 'Free cancellation up to 2 hours before your appointment.'],
            ['Overline / 600', 'text-overline uppercase', 'Delivery partner'],
          ].map(([label, cls, text]) => (
            <div key={label} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-baseline sm:gap-6">
              <span className="w-40 shrink-0 text-caption text-subtle">{label}</span>
              <span className={cls + ' text-fg'}>{text}</span>
            </div>
          ))}
        </Card>
      </section>

      {/* Color */}
      <section>
        <SectionHead title="Color palette" subtitle="Trust Teal primary, Assurance Blue accent, clear semantics." />
        <div className="space-y-5">
          <div className="grid grid-cols-5 gap-3 sm:grid-cols-10">
            {brandScale.map(([n, cls, hex]) => <Swatch key={n} name={n} className={cls} hex={hex} />)}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Swatch name="Accent" className="bg-accent-600" hex="#2563eb" />
            <Swatch name="Success" className="bg-success" hex="#16a34a" />
            <Swatch name="Warning" className="bg-warning" hex="#d97706" />
            <Swatch name="Danger" className="bg-danger" hex="#dc2626" />
            <Swatch name="Surface" className="bg-surface" />
            <Swatch name="Surface 2" className="bg-surface-2" />
            <Swatch name="Border" className="bg-border" />
            <Swatch name="Foreground" className="bg-fg" />
          </div>
        </div>
      </section>

      {/* Iconography */}
      <section>
        <SectionHead title="Iconography" subtitle="Lucide · 1.75px stroke · rounded caps for a friendly, medical feel." />
        <Card className="p-5">
          <div className="grid grid-cols-6 gap-4 sm:grid-cols-9 lg:grid-cols-12">
            {icons.map((Icon, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5">
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-surface-2 text-fg">
                  <Icon className="h-5 w-5" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </section>

      {/* Components */}
      <section>
        <SectionHead title="Components" subtitle="Composable, accessible primitives with consistent states." />
        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="space-y-4 p-5">
            <p className="text-overline uppercase text-subtle">Buttons</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="soft">Soft</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
              <Button loading>Loading</Button>
              <Button disabled>Disabled</Button>
            </div>
          </Card>

          <Card className="space-y-4 p-5">
            <p className="text-overline uppercase text-subtle">Badges & status</p>
            <div className="flex flex-wrap gap-2">
              <Badge tone="brand" dot>In stock</Badge>
              <Badge tone="success">OTC</Badge>
              <Badge tone="warning">Rx required</Badge>
              <Badge tone="danger">Out of stock</Badge>
              <Badge tone="info">New</Badge>
              <Badge tone="neutral">Neutral</Badge>
            </div>
            <p className="text-overline uppercase text-subtle">Segmented</p>
            <Segmented options={['Design', 'Code', 'Preview']} value={seg} onChange={setSeg} />
          </Card>

          <Card className="space-y-4 p-5">
            <p className="text-overline uppercase text-subtle">Inputs</p>
            <Input icon={Search} placeholder="Search medicines…" />
            <Input placeholder="Full name" />
            <div className="flex items-center gap-3">
              <Rating value={4.8} count={312} />
              <Avatar name="Meron A" />
              <IconTile icon={HeartPulse} />
            </div>
          </Card>

          <Card className="space-y-4 p-5">
            <p className="text-overline uppercase text-subtle">Feedback</p>
            <ul className="space-y-2">
              <CheckItem>Licensed pharmacy verified</CheckItem>
              <CheckItem>Prescription approved by pharmacist</CheckItem>
            </ul>
            <div className="space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          </Card>
        </div>
      </section>

      {/* Elevation & radius */}
      <section>
        <SectionHead title="Elevation & radius" subtitle="Soft, diffuse shadows. Generous rounding for approachability." />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[['shadow-xs', 'xs'], ['shadow-sm', 'sm'], ['shadow-md', 'md'], ['shadow-lg', 'lg']].map(([cls, label]) => (
            <div key={label} className={'grid h-24 place-items-center rounded-2xl bg-surface text-caption font-semibold text-muted ' + cls}>{label}</div>
          ))}
        </div>
      </section>
    </div>
  )
}
