import { useState } from 'react';
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Drawer, IconButton, Skeleton, Stack, TextField, Typography } from '@mui/material';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { DocumentRow } from '@/features/verifications/AdminVerificationsPage';
import { adminDoctorsService, doctorActionMessage, feeLabel } from '@/services/adminDoctors.service';
import { providerTypeLabel } from '@/services/adminProviders.service';
import { adminVerificationsService } from '@/services/adminVerifications.service';
import { ApiError } from '@/services/apiClient';
import { isValidSuspendReason, MAX_SUSPEND_REASON, MIN_SUSPEND_REASON } from '@/services/pharmacies.service';
import { formatDate } from '@/utils/format';

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
 * Work 169: one doctor — licence and its files (each previewable), account, profile and fees,
 * and where they practise — with Disable (hides them and signs them out; a reason is kept) and
 * Enable (on a current licence).
 */
export function DoctorRecord({ doctorId, onClose }: { doctorId: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const canManage = can('doctors:manage');
  const qc = useQueryClient();
  const notify = useNotify();
  const [disabling, setDisabling] = useState(false);
  const [reason, setReason] = useState('');
  const enabled = !!doctorId;

  const record = useQuery({ queryKey: ['doctors', 'record', doctorId], queryFn: () => adminDoctorsService.get(doctorId as string), enabled });
  const userId = record.data?.userId;
  const files = useQuery({
    queryKey: ['doctors', 'files', userId],
    enabled: !!userId,
    retry: false,
    queryFn: () => adminVerificationsService.history({ userId: userId as string, type: 'DOCTOR_LICENSE', size: 20 }),
  });

  const change = useMutation({
    mutationFn: (action: 'suspend' | 'reactivate'): Promise<unknown> =>
      action === 'suspend' ? adminDoctorsService.suspend(doctorId as string, reason) : adminDoctorsService.reactivate(doctorId as string),
    onSuccess: (_r, action) => {
      qc.invalidateQueries({ queryKey: ['doctors'] });
      notify(action === 'suspend' ? 'Doctor disabled. They are signed out and hidden from patients.' : 'Doctor enabled again. Patients can find and book them.');
      setDisabling(false);
      setReason('');
    },
    onError: (error) => notify(doctorActionMessage(error, 'The change could not be made.'), 'error'),
  });

  const d = record.data;
  return (
    <Drawer anchor="right" open={enabled} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', md: 600 } } }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" sx={{ p: 2.5, pb: 1.5 }}>
        <Box>
          <Typography variant="h5">{d?.fullName ?? 'Doctor'}</Typography>
          {d ? (
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              {d.specialty ? <Chip size="small" label={d.specialty} /> : null}
              <StatusChip status={d.status.toLowerCase()} />
              {!d.isVerified ? <StatusChip status="unverified" /> : null}
            </Stack>
          ) : null}
        </Box>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      {d && canManage ? (
        <Stack direction="row" spacing={1} sx={{ px: 2.5, pb: 1.5 }}>
          {d.status === 'SUSPENDED' ? (
            <Button color="success" variant="contained" startIcon={<CheckCircleRoundedIcon />} disabled={change.isPending} onClick={() => change.mutate('reactivate')}>
              Enable doctor
            </Button>
          ) : (
            <Button color="error" variant="outlined" startIcon={<BlockRoundedIcon />} onClick={() => setDisabling(true)}>
              Disable doctor
            </Button>
          )}
        </Stack>
      ) : null}
      <Divider />
      <Stack spacing={2.5} sx={{ p: 2.5 }}>
        {record.isLoading ? <Skeleton variant="rounded" height={160} /> : null}
        {record.error ? <Alert severity="error">{message(record.error, 'The doctor could not be loaded.')}</Alert> : null}
        {d ? (
          <>
            <Section title="Licence">
              <Field label="Licence number" value={d.licenseNumber ?? '—'} />
              <Field label="Valid until" value={d.licenseExpiresAt ? formatDate(d.licenseExpiresAt) : '—'} />
              <Field label="Registered" value={formatDate(d.createdAt)} />
            </Section>
            <Section title="Licence files">
              {files.isLoading ? <Skeleton variant="rounded" height={80} /> : null}
              {files.error ? <Alert severity="error">{message(files.error, 'The files could not be loaded.')}</Alert> : null}
              {files.data && files.data.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No files on record.
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
            <Section title="Account">
              <Field label="E-mail" value={d.account?.email ?? '—'} />
              <Field label="Phone" value={d.account?.phone ?? '—'} />
              <Field label="Account" value={d.account ? <StatusChip status={d.account.status.toLowerCase()} /> : '—'} />
            </Section>
            <Section title="Profile">
              <Field label="Amharic name" value={d.fullNameAm ?? '—'} />
              <Field label="Sub-specialties" value={d.subSpecialties.join(', ') || '—'} />
              <Field label="Experience" value={d.yearsExperience === null ? '—' : `${d.yearsExperience} years`} />
              <Field label="Languages" value={d.languages.join(', ') || '—'} />
              <Field label="Fee in person" value={feeLabel(d.consultationFeeInPerson, d.currency)} />
              <Field label="Fee by video" value={d.acceptsTelemedicine ? feeLabel(d.consultationFeeTele, d.currency) : 'No video appointments'} />
              {d.qualifications.length > 0 ? <Field label="Qualifications" value={d.qualifications.join('; ')} /> : null}
              {d.bio ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {d.bio}
                </Typography>
              ) : null}
            </Section>
            <Section title="Where they practise">
              {d.affiliations.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No facility yet. A hospital or clinic adds the doctor from its portal.
                </Typography>
              ) : (
                d.affiliations.map((a) => (
                  <Field
                    key={a.providerId}
                    label={`${a.providerName} · ${providerTypeLabel(a.providerType)}${a.isPrimary ? ' · main' : ''}`}
                    value={[a.departmentName, a.roleTitle].filter(Boolean).join(', ') || '—'}
                  />
                ))
              )}
            </Section>
          </>
        ) : null}
      </Stack>
      <Dialog open={disabling} onClose={() => setDisabling(false)} fullWidth maxWidth="sm">
        <DialogTitle>Disable this doctor?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            They are signed out at once, hidden from patients and cannot be booked. Their records stay, and you can enable them again while their licence is valid.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label="Reason (kept in the audit log)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            helperText={`${MIN_SUSPEND_REASON}–${MAX_SUSPEND_REASON} characters.`}
            inputProps={{ maxLength: MAX_SUSPEND_REASON }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDisabling(false)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={!isValidSuspendReason(reason) || change.isPending} onClick={() => change.mutate('suspend')}>
            Disable doctor
          </Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  );
}
