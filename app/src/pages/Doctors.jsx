import ComingLater from '../components/ComingLater'
import { t } from '../auth/strings'

/** Work 99: doctor booking (Modules 09–10) is deferred by the owner; no sample doctors are shown. */
export default function Doctors() {
  return (
    <ComingLater
      title={t('doctors.title')}
      description={t('doctors.body')}
    />
  )
}
