import { Link } from 'react-router-dom'
import { Clock } from 'lucide-react'
import { Button, Card } from './ui'

/**
 * Work 99: a service PharmaLink will offer later (Modules 09–12 are deferred by the owner). No
 * sample data: the page says plainly that the service is not available yet.
 */
export default function ComingLater({ title, description }) {
  return (
    <Card className="mx-auto flex max-w-xl flex-col items-center gap-4 p-10 text-center" role="region" aria-label={title}>
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-surface-2 text-brand-500">
        <Clock className="h-7 w-7" aria-hidden="true" />
      </div>
      <h1 className="font-display text-h2 text-fg">{title}</h1>
      <p className="text-body text-muted">{description}</p>
      <p className="text-caption text-subtle">Coming later. Nothing here can be booked yet.</p>
      <Button as={Link} to="/search" variant="secondary">Search medicines instead</Button>
    </Card>
  )
}
