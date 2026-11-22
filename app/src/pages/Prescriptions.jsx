import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { FileText, RefreshCw, Upload } from 'lucide-react'
import { Badge, Button, Card, Input, Skeleton } from '../components/ui'
import { useAuth } from '../auth/AuthContext'
import { checkFile, createPrescriptionsService } from '../prescriptions/prescriptionsService'
import { t } from '../auth/strings'

/** Each state's tone; its label is the message rx.status.<state> (Work 143). */
const STATUS = {
  UPLOADED: 'info',
  UNDER_REVIEW: 'info',
  CLARIFICATION_REQUESTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CONSUMED: 'neutral',
  EXPIRED: 'neutral',
}

export function usePrescriptions() {
  const { request } = useAuth()
  return useMemo(() => createPrescriptionsService({ request }), [request])
}

/**
 * Work 101: upload a prescription (PDF or photo) for a pharmacist to check, and see where each one
 * stands. The file goes to PharmaLink's document storage through a signed link; only the customer
 * and the reviewing pharmacist can open it, and every opening is logged.
 */
export default function Prescriptions() {
  const service = usePrescriptions()
  const [list, setList] = useState({ status: 'loading', items: [] })
  const [file, setFile] = useState(null)
  const [doctorName, setDoctorName] = useState('')
  const [hospitalName, setHospitalName] = useState('')
  const [upload, setUpload] = useState({ status: 'idle', error: null })

  const load = useCallback(() => {
    setList((l) => ({ ...l, status: 'loading' }))
    service
      .list()
      .then((items) => setList({ status: 'ready', items }))
      .catch(() => setList({ status: 'error', items: [] }))
  }, [service])

  useEffect(load, [load])

  async function submit(e) {
    e.preventDefault()
    const problem = checkFile(file)
    if (problem) return setUpload({ status: 'idle', error: problem })
    setUpload({ status: 'uploading', error: null })
    try {
      await service.upload(file, { doctorName, hospitalName })
      setUpload({ status: 'done', error: null })
      setFile(null)
      setDoctorName('')
      setHospitalName('')
      e.target.reset()
      load()
    } catch (error) {
      setUpload({ status: 'idle', error: error?.message || t('checkout.rx.uploadFailed') })
    }
  }

  async function open(id) {
    try {
      const link = await service.fileLink(id)
      window.open(link.url, '_blank', 'noopener')
    } catch (error) {
      setUpload({ status: 'idle', error: error?.message || t('rx.openFailed') })
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-h1 text-fg">{t('rx.title')}</h1>
        <p className="text-body text-muted">{t('rx.subtitle')}</p>
      </div>

      <Card className="p-5">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" aria-label={t('common.uploadPrescription')}>
          <label className="sm:col-span-2">
            <span className="mb-1 block text-caption text-muted">{t('rx.fileLabel')}</span>
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              aria-label={t('rx.file')}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-body text-fg"
            />
          </label>
          <Input aria-label={t('rx.doctor')} placeholder={t('rx.doctor')} value={doctorName} onChange={(e) => setDoctorName(e.target.value)} maxLength={200} />
          <Input aria-label={t('rx.hospital')} placeholder={t('rx.hospital')} value={hospitalName} onChange={(e) => setHospitalName(e.target.value)} maxLength={200} />
          {upload.error && <p role="alert" className="text-caption text-danger sm:col-span-2">{upload.error}</p>}
          {upload.status === 'done' && <p role="status" className="text-caption text-success sm:col-span-2">{t('rx.uploaded')}</p>}
          <Button type="submit" disabled={upload.status === 'uploading'} className="sm:col-span-2">
            <Upload className="h-4 w-4" aria-hidden="true" /> {t(upload.status === 'uploading' ? 'common.uploading' : 'rx.upload')}
          </Button>
        </form>
      </Card>

      <section aria-live="polite">
        <h2 className="mb-3 text-h3 text-fg">{t('rx.list')}</h2>
        {list.status === 'loading' && <Skeleton className="h-20" />}
        {list.status === 'error' && (
          <Card className="flex items-center justify-between gap-3 p-4">
            <p className="text-body text-fg">{t('rx.loadFailed')}</p>
            <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}</Button>
          </Card>
        )}
        {list.status === 'ready' && list.items.length === 0 && <p className="text-caption text-muted">{t('rx.empty')}</p>}
        {list.status === 'ready' && list.items.length > 0 && (
          <div className="space-y-3">
            {list.items.map((p) => {
              const code = p.displayStatus ?? p.status
              const s = STATUS[code] ? { label: t(`rx.status.${code}`), tone: STATUS[code] } : { label: p.status, tone: 'neutral' }
              return (
                <Card key={p.id} className="flex flex-wrap items-center gap-3 p-4" data-testid="prescription">
                  <FileText className="h-5 w-5 text-brand-500" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-fg">{p.doctorName ? t('rx.doctorName', { name: p.doctorName }) : t('common.prescription')}{p.hospitalName ? ` · ${p.hospitalName}` : ''}</p>
                    <p className="text-caption text-muted">{t('rx.uploadedOn', { date: new Date(p.createdAt).toLocaleDateString() })}</p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                  {typeof p.fileRef === 'string' && p.fileRef.startsWith('doc:') && (
                    <Button variant="ghost" size="sm" onClick={() => open(p.id)}>{t('rx.openFile')}</Button>
                  )}
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <p className="text-caption text-subtle">
        {t('rx.howToOrder')} <Link to="/checkout" className="font-semibold text-brand-600">{t('common.goToCheckout')}</Link>. {t('rx.notSure')} <Link to="/requests/new" className="font-semibold text-brand-600">{t('rx.sendNearby')}</Link>.
      </p>
    </div>
  )
}
