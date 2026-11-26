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
  TextField,
  Typography,
} from '@mui/material';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { DocumentRow } from '@/features/verifications/AdminVerificationsPage';
import {
  adminProvidersService,
  EMERGENCY_LABELS,
  providerActionMessage,
  providerTypeLabel,
  SERVICE_TYPE_LABELS,
  WEEKDAYS,
} from '@/services/adminProviders.service';
import { adminVerificationsService } from '@/services/adminVerifications.service';
import { ApiError } from '@/services/apiClient';
import { isValidSuspendReason, MAX_SUSPEND_REASON, MIN_SUSPEND_REASON, personLabel } from '@/services/pharmacies.service';
import { currency, formatDate } from '@/utils/format';

const message = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2} sx={{ py: 0.5 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ textAlign: 'right' }}>
        {value}
      </Typography>
    </Stack>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

/**
 * Work 163: one healthcare provider — registration, licence and its files (each previewable),
 * administrator and staff, locations with hours and facilities, departments and services — with
 * Disable (a reason, kept in its history) and Enable (the licence is re-checked).
 */
export function ProviderRecord({ providerId, onClose }: { providerId: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const canManage = can('providers:manage');
  const qc = useQueryClient();
  const notify = useNotify();
  const [disabling, setDisabling] = useState(false);
  const [reason, setReason] = useState('');
  const enabled = !!providerId;

  const record = useQuery({ queryKey: ['providers', 'record', providerId], queryFn: () => adminProvidersService.get(providerId as string), enabled });
  const organizationId = record.data?.organizationId;
  const files = useQuery({
    queryKey: ['providers', 'files', organizationId],
    enabled: !!organizationId,
    retry: false,
    // Every status: the queue alone answers only pending requests.
    queryFn: () => adminVerificationsService.history({ organizationId: organizationId as string, type: 'FACILITY_LICENSE', size: 20 }),
  });

  const change = useMutation({
    mutationFn: (action: 'suspend' | 'reactivate'): Promise<unknown> =>
      action === 'suspend' ? adminProvidersService.suspend(providerId as string, reason) : adminProvidersService.reactivate(providerId as string),
    onSuccess: (_r, action) => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      notify(action === 'suspend' ? 'Provider disabled. It no longer appears to customers.' : 'Provider enabled again. Customers can find it.');
      setDisabling(false);
      setReason('');
    },
    onError: (error) => notify(providerActionMessage(error, 'The change could not be made.'), 'error'),
  });

  const p = record.data;
  const org = p?.organization;

  return (
    <Drawer anchor="right" open={enabled} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', md: 640 } } }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" sx={{ p: 2.5, pb: 1.5 }}>
        <Box>
          <Typography variant="h5">{p?.displayName ?? 'Provider'}</Typography>
          {p ? (
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Chip size="small" label={providerTypeLabel(p.type)} />
              <StatusChip status={p.status.toLowerCase()} />
              {p.licenseStatus !== 'VALID' ? <StatusChip status={`licence ${p.licenseStatus.toLowerCase()}`} /> : null}
            </Stack>
          ) : null}
        </Box>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>

      {p && canManage ? (
        <Stack direction="row" spacing={1} sx={{ px: 2.5, pb: 1.5 }}>
          {p.status === 'SUSPENDED' ? (
            <Button color="success" variant="contained" startIcon={<CheckCircleRoundedIcon />} disabled={change.isPending} onClick={() => change.mutate('reactivate')}>
              Enable provider
            </Button>
          ) : (
            <Button color="error" variant="outlined" startIcon={<BlockRoundedIcon />} onClick={() => setDisabling(true)}>
              Disable provider
            </Button>
          )}
        </Stack>
      ) : null}
      <Divider />

      <Stack spacing={2.5} sx={{ p: 2.5 }}>
        {record.isLoading ? <Skeleton variant="rounded" height={160} /> : null}
        {record.error ? <Alert severity="error">{message(record.error, 'The provider could not be loaded.')}</Alert> : null}

        {p ? (
          <>
            <Section title="Registration and licence">
              <Field label="Legal name" value={org?.name ?? '—'} />
              <Field label="Registered" value={formatDate(p.createdAt)} />
              <Field label="Licence number" value={org?.licenseNumber ?? '—'} />
              <Field label="Licence valid until" value={p.licenseExpiresAt ? formatDate(p.licenseExpiresAt) : '—'} />
              <Field label="Organisation" value={org ? <StatusChip status={org.status.toLowerCase()} /> : '—'} />
            </Section>

            <Section title="Licence files">
              {files.isLoading ? <Skeleton variant="rounded" height={80} /> : null}
              {files.error ? <Alert severity="error">{message(files.error, 'The licence files could not be loaded.')}</Alert> : null}
              {files.data && files.data.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No licence files on record.
                </Typography>
              ) : null}
              <Stack spacing={1.5}>
                {files.data?.map((request) => (
                  <Box key={request.requestId} sx={{ p: 1.5, borderRadius: 2, border: 1, borderColor: 'divider' }}>
                    <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                      <Typography variant="body2">Submitted {formatDate(request.submittedAt)}</Typography>
                      <StatusChip status={request.status.toLowerCase()} />
                    </Stack>
                    {request.documents.map((document, index) => (
                      <DocumentRow key={`${request.requestId}-${index}`} requestId={request.requestId} index={index} document={document} />
                    ))}
                  </Box>
                ))}
              </Stack>
            </Section>

            <Section title="People">
              {org ? (
                <>
                  <Field label="Administrator" value={personLabel(org.owner)} />
                  {org.members
                    .filter((m) => m.userId !== org.owner.userId)
                    .map((m) => (
                      <Field key={m.userId} label={m.roles.join(', ')} value={personLabel(m)} />
                    ))}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  The organisation could not be read.
                </Typography>
              )}
            </Section>

            <Section title="Profile">
              <Field label="Amharic name" value={p.nameAm ?? '—'} />
              <Field label="Phone" value={p.contactPhone ?? '—'} />
              <Field label="E-mail" value={p.contactEmail ?? '—'} />
              <Field label="Website" value={p.website ?? '—'} />
              {p.description ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {p.description}
                </Typography>
              ) : null}
            </Section>

            <Section title={`Locations (${p.locations.length})`}>
              {p.locations.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No locations yet. The provider adds them in its portal.
                </Typography>
              ) : null}
              <Stack spacing={1.5}>
                {p.locations.map((l) => (
                  <Box key={l.locationId} sx={{ p: 1.5, borderRadius: 2, border: 1, borderColor: 'divider' }}>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {l.name}
                      </Typography>
                      {l.isPrimary ? <Chip size="small" label="Main" /> : null}
                      {!l.isActive ? <Chip size="small" label="Closed" /> : null}
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      {[l.addressLine, l.subcity, l.city].filter(Boolean).join(', ') || '—'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {EMERGENCY_LABELS[l.emergencyAvailability] ?? l.emergencyAvailability}
                      {l.phone ? ` · ${l.phone}` : ''}
                    </Typography>
                    {l.hours.length > 0 ? (
                      <Box sx={{ mt: 0.5 }}>
                        {l.hours.map((h) => (
                          <Field key={h.weekday} label={WEEKDAYS[h.weekday] ?? String(h.weekday)} value={h.isClosed ? 'Closed' : `${h.openTime}–${h.closeTime}`} />
                        ))}
                      </Box>
                    ) : null}
                    {l.facilities.length > 0 ? (
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', rowGap: 0.5 }}>
                        {l.facilities.map((f) => (
                          <Chip key={f} size="small" variant="outlined" label={f} />
                        ))}
                      </Stack>
                    ) : null}
                  </Box>
                ))}
              </Stack>
            </Section>

            {p.departments.length > 0 ? (
              <Section title={`Departments (${p.departments.length})`}>
                {p.departments.map((d) => (
                  <Field key={d.departmentId} label={d.name} value={d.isActive ? (d.specialty ?? 'Open') : 'Closed'} />
                ))}
              </Section>
            ) : null}

            {p.services.length > 0 ? (
              <Section title={`Services (${p.services.length})`}>
                {p.services.map((s) => (
                  <Field
                    key={s.serviceId}
                    label={`${s.name} · ${SERVICE_TYPE_LABELS[s.type] ?? s.type}`}
                    value={`${s.price !== null ? currency(s.price / 100, s.currency) : 'Price on request'}${s.isAvailable ? '' : ' · unavailable'}`}
                  />
                ))}
              </Section>
            ) : null}
          </>
        ) : null}
      </Stack>

      <Dialog open={disabling} onClose={() => setDisabling(false)} fullWidth maxWidth="sm">
        <DialogTitle>Disable this provider?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            It disappears from customer search at once, and its administrator cannot change its profile. Its records stay, and you can enable it again if its licence is still valid.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label="Reason (kept in the provider's history)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            helperText={`${MIN_SUSPEND_REASON}–${MAX_SUSPEND_REASON} characters.`}
            inputProps={{ maxLength: MAX_SUSPEND_REASON }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDisabling(false)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={!isValidSuspendReason(reason) || change.isPending} onClick={() => change.mutate('suspend')}>
            Disable provider
          </Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  );
}
