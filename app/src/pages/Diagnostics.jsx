import ComingLater from '../components/ComingLater'
import { t } from '../auth/strings'

/** Work 99: diagnostics and lab tests (Module 11) are deferred by the owner; no sample tests are shown. */
export default function Diagnostics() {
  return (
    <ComingLater
      title={t('diagnostics.title')}
      description={t('diagnostics.body')}
    />
  )
}
