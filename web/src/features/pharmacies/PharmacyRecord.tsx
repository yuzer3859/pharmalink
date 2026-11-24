import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { useActivatePharmacy, usePharmacyRecord, useSuspendPharmacy } from '@/hooks/usePharmacies';
import { DocumentRow } from '@/features/verifications/AdminVerificationsPage';
import { humanizeStatus } from '@/services/adminAnalytics.service';
import { isValidSuspendReason, MAX_SUSPEND_REASON, MIN_SUSPEND_REASON, personLabel } from '@/services/pharmacies.service';
import { formatDate, formatDateTime } from '@/utils/format';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2} sx={{ py: 0.5 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ textAlign: 'right', wordBreak: 'break-word' }}>
        {value}
      </Typography>
    </Stack>
  );
}

function Section({ error, loading, children }: { error: unknown; loading: boolean; children: React.ReactNode }) {
  if (error) {
    return <Alert severity="error">{error instanceof Error ? error.message : 'This part of the record could not be loaded.'}</Alert>;
  }
  if (loading) return <Skeleton variant="rounded" height={140} />;
  return <>{children}</>;
}

/** What a history entry says, in words. */
const HISTORY: Record<string, string> = {
  PHARMACY_REGISTERED: 'Registered',
  PHARMACY_ACTIVATED: 'Enabled (licence checked)',
  PHARMACY_SUSPENDED: 'Disabled by an administrator',
  PHARMACY_AUTO_SUSPENDED: 'Disabled automatically: licence expired',
  PHARMACY_PROFILE_UPDATED: 'Profile changed',
};

function DisableDialog({ pharmacyId, name, onClose }: { pharmacyId: string; name: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const suspend = useSuspendPharmacy(onClose);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Disable {name}?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The pharmacy stops trading at once: customers can no longer find it or buy from it, and its owner is told. Its data and files are kept, and you can
          enable it again later.
        </Typography>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={3}
          label="Reason (kept in the pharmacy's history)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          helperText={`${MIN_SUSPEND_REASON}–${MAX_SUSPEND_REASON} characters.`}
          inputProps={{ maxLength: MAX_SUSPEND_REASON }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          color="error"
          variant="contained"
          startIcon={<BlockRoundedIcon />}
          disabled={!isValidSuspendReason(reason) || suspend.isPending}
          onClick={() => suspend.mutate({ pharmacyId, reason })}
        >
          Disable pharmacy
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Work 153: everything the platform holds about one pharmacy — its registration and licence, its
 * owner and staff, the licence files it submitted (each previewable), its branches and listings,
 * and its history — with disable (reason required) and enable (licence re-checked).
 */
export function PharmacyRecord({ pharmacyId, organizationId, onClose }: { pharmacyId: string | null; organizationId: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const canDecide = can('pharmacies:manage');
  const [tab, setTab] = useState(0);
  const [disabling, setDisabling] = useState(false);
  const { pharmacy, people, files, history } = usePharmacyRecord(pharmacyId, organizationId);
  const activate = useActivatePharmacy();
  const p = pharmacy.data;
  const org = people.data;

  return (
    <Drawer anchor="right" open={!!pharmacyId} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', md: 720 } } }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" sx={{ p: 2.5, pb: 1.5 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5">{p?.displayName ?? 'Pharmacy'}</Typography>
          {org ? (
            <Typography variant="body2" color="text.secondary">
              {org.name} · registered {formatDate(org.createdAt)}
            </Typography>
          ) : null}
          {p ? (
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
              <StatusChip status={p.transactingStatus.toLowerCase()} />
              <Chip size="small" variant="outlined" label={`Licence ${p.licenseStatus.toLowerCase()}`} />
              <Chip size="small" variant="outlined" color={p.eligible ? 'success' : 'default'} label={p.eligible ? 'Can trade' : 'Cannot trade'} />
            </Stack>
          ) : null}
        </Box>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>

      {p && canDecide ? (
        <Stack direction="row" spacing={1} sx={{ px: 2.5, pb: 1.5 }}>
          {p.transactingStatus === 'ACTIVE' ? (
            <Button color="error" variant="outlined" startIcon={<BlockRoundedIcon />} onClick={() => setDisabling(true)}>
              Disable pharmacy
            </Button>
          ) : (
            <Button color="success" variant="contained" startIcon={<CheckCircleRoundedIcon />} disabled={activate.isPending} onClick={() => activate.mutate(p.pharmacyId)}>
              Enable pharmacy
            </Button>
          )}
        </Stack>
      ) : null}

      <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="scrollable" sx={{ px: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="Overview" />
        <Tab label={`Owner & staff${org ? ` (${org.members.length})` : ''}`} />
        <Tab label={`Licence & files${files.data ? ` (${files.data.length})` : ''}`} />
        <Tab label="History" />
      </Tabs>

      <Box sx={{ p: 2.5 }}>
        {tab === 0 ? (
          <Section error={pharmacy.error} loading={pharmacy.isLoading}>
            {p ? (
              <Stack divider={<Divider flexItem />}>
                <Field label="Storefront name" value={p.displayName} />
                <Field label="Organisation" value={org?.name ?? '—'} />
                <Field label="Organisation status" value={org ? humanizeStatus(org.status) : '—'} />
                <Field label="Licence number" value={org?.licenseNumber ?? '—'} />
                <Field label="Licence expires" value={p.licenseExpiresAt ? formatDate(p.licenseExpiresAt) : '—'} />
                <Field label="Owner" value={org ? personLabel(org.owner) : '—'} />
                <Field label="Registered" value={formatDateTime(p.createdAt)} />
                <Field label="Last changed" value={formatDateTime(p.updatedAt)} />
                <Field label="Branches (active / total)" value={`${p.branches.active} / ${p.branches.total}`} />
                <Field label="Products listed (customers can buy / total)" value={`${p.listings.customerPurchasable} / ${p.listings.total}`} />
                <Field label="In stock / out of stock" value={`${p.listings.inStock} / ${p.listings.outOfStock}`} />
                <Field label="Pharmacy id" value={<Typography variant="caption">{p.pharmacyId}</Typography>} />
              </Stack>
            ) : null}
          </Section>
        ) : null}

        {tab === 1 ? (
          <Section error={people.error} loading={people.isLoading}>
            {org ? (
              <Stack spacing={1.5}>
                <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
                  <Typography variant="overline" color="text.secondary">
                    Owner
                  </Typography>
                  <Field label="E-mail" value={org.owner.email ?? '—'} />
                  <Field label="Phone" value={org.owner.phone ?? '—'} />
                  <Field label="Account" value={<StatusChip status={org.owner.status.toLowerCase()} />} />
                </Box>
                <Typography variant="subtitle2">Everyone with a role in this pharmacy</Typography>
                {org.members.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No one yet.
                  </Typography>
                ) : null}
                {org.members.map((m) => (
                  <Stack key={m.userId} direction="row" spacing={1.5} alignItems="center" justifyContent="space-between" sx={{ py: 0.75 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" noWrap>
                        {personLabel(m)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {m.roles.map(humanizeStatus).join(', ')} · since {formatDate(m.since)}
                      </Typography>
                    </Box>
                    <StatusChip status={m.status.toLowerCase()} />
                  </Stack>
                ))}
              </Stack>
            ) : null}
          </Section>
        ) : null}

        {tab === 2 ? (
          <Section error={files.error} loading={files.isLoading}>
            {files.data && files.data.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No licence or verification files on record.
              </Typography>
            ) : null}
            <Stack spacing={2}>
              {files.data?.map((request) => (
                <Box key={request.requestId} sx={{ p: 1.5, borderRadius: 2, border: 1, borderColor: 'divider' }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                    <Typography variant="subtitle2">{humanizeStatus(request.type)}</Typography>
                    <StatusChip status={request.status.toLowerCase()} />
                  </Stack>
                  <Field label="Submitted" value={formatDateTime(request.submittedAt)} />
                  {request.reviewedAt ? <Field label="Reviewed" value={formatDateTime(request.reviewedAt)} /> : null}
                  {request.licenseNumber ? <Field label="Licence number" value={request.licenseNumber} /> : null}
                  {request.expiresAt ? <Field label="Valid until" value={formatDate(request.expiresAt)} /> : null}
                  {request.rejectReason ? <Field label="Rejected because" value={request.rejectReason} /> : null}
                  <Divider sx={{ my: 1 }} />
                  <Stack spacing={1}>
                    {request.documents.map((document, index) => (
                      <DocumentRow key={`${request.requestId}-${index}`} requestId={request.requestId} index={index} document={document} />
                    ))}
                  </Stack>
                </Box>
              ))}
            </Stack>
          </Section>
        ) : null}

        {tab === 3 ? (
          <Section error={history.error} loading={history.isLoading}>
            {history.data && history.data.items.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No recorded changes.
              </Typography>
            ) : null}
            <Stack spacing={1}>
              {history.data?.items.map((entry) => {
                const reason = (entry.context as { reason?: unknown } | null)?.reason;
                return (
                  <Box key={entry.id} sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
                    <Typography variant="body2">{HISTORY[entry.action] ?? humanizeStatus(entry.action)}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatDateTime(entry.createdAt)}
                      {typeof reason === 'string' && reason !== 'LICENSE_EXPIRED' ? ` · ${reason}` : ''}
                    </Typography>
                  </Box>
                );
              })}
            </Stack>
          </Section>
        ) : null}
      </Box>

      {disabling && p ? <DisableDialog pharmacyId={p.pharmacyId} name={p.displayName} onClose={() => setDisabling(false)} /> : null}
    </Drawer>
  );
}
