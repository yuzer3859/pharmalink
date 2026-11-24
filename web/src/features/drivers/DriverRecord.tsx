import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
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
import { humanizeStatus } from '@/services/adminAnalytics.service';
import { adminAccountsService, isValidReason, MAX_REASON_LENGTH, MIN_REASON_LENGTH } from '@/services/adminAccounts.service';
import { adminDriversService, VEHICLE_TYPES } from '@/services/adminDrivers.service';
import { adminVerificationsService } from '@/services/adminVerifications.service';
import { ApiError } from '@/services/apiClient';
import { formatDate, formatDateTime } from '@/utils/format';

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

/**
 * Work 156: one driver — their account, vehicle and working area, availability, and the documents
 * they were approved on (each previewable) — with Disable (suspends the account: no offers, no
 * going online) and Enable again.
 */
export function DriverRecord({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const canManage = can('drivers:manage');
  const qc = useQueryClient();
  const notify = useNotify();
  const [disabling, setDisabling] = useState(false);
  const [reason, setReason] = useState('');
  const enabled = !!userId;

  const account = useQuery({ queryKey: ['drivers', 'account', userId], queryFn: () => adminAccountsService.get(userId as string), enabled });
  const profile = useQuery({ queryKey: ['drivers', 'profile', userId], queryFn: () => adminDriversService.profile(userId as string), enabled, retry: false });
  const documents = useQuery({
    queryKey: ['drivers', 'documents', userId],
    enabled,
    retry: false,
    // Every status: the queue alone answers only pending requests.
    queryFn: () => adminVerificationsService.history({ userId: userId as string, type: 'DRIVER_DOCS', size: 20 }),
  });

  const change = useMutation({
    mutationFn: (action: 'suspend' | 'reinstate') =>
      action === 'suspend' ? adminAccountsService.suspend(userId as string, reason) : adminAccountsService.reinstate(userId as string),
    onSuccess: (_r, action) => {
      qc.invalidateQueries({ queryKey: ['drivers'] });
      notify(action === 'suspend' ? 'Driver disabled. They are signed out and get no more deliveries.' : 'Driver enabled again. They can sign in and go online.');
      setDisabling(false);
      setReason('');
    },
    onError: (error) => notify(message(error, 'The change could not be made.'), 'error'),
  });

  const a = account.data;
  const p = profile.data;
  const vehicle = VEHICLE_TYPES.find((v) => v.value === p?.vehicleType)?.label ?? p?.vehicleType ?? '—';

  return (
    <Drawer anchor="right" open={enabled} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', md: 600 } } }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" sx={{ p: 2.5, pb: 1.5 }}>
        <Box>
          <Typography variant="h5">{a?.email ?? a?.phone ?? 'Driver'}</Typography>
          {a ? (
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <StatusChip status={a.status.toLowerCase()} />
              {p ? <StatusChip status={p.availability.toLowerCase()} /> : null}
            </Stack>
          ) : null}
        </Box>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>

      {a && canManage ? (
        <Stack direction="row" spacing={1} sx={{ px: 2.5, pb: 1.5 }}>
          {a.status === 'SUSPENDED' ? (
            <Button color="success" variant="contained" startIcon={<CheckCircleRoundedIcon />} disabled={change.isPending} onClick={() => change.mutate('reinstate')}>
              Enable driver
            </Button>
          ) : (
            <Button color="error" variant="outlined" startIcon={<BlockRoundedIcon />} onClick={() => setDisabling(true)}>
              Disable driver
            </Button>
          )}
        </Stack>
      ) : null}
      <Divider />

      <Stack spacing={2.5} sx={{ p: 2.5 }}>
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Account
          </Typography>
          {account.isLoading ? <Skeleton variant="rounded" height={90} /> : null}
          {account.error ? <Alert severity="error">{message(account.error, 'The account could not be loaded.')}</Alert> : null}
          {a ? (
            <>
              <Field label="E-mail" value={a.email ?? '—'} />
              <Field label="Phone" value={a.phone ?? '—'} />
              <Field label="Signed up" value={formatDate(a.createdAt)} />
            </>
          ) : null}
        </Box>

        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Vehicle and work
          </Typography>
          {profile.isLoading ? <Skeleton variant="rounded" height={110} /> : null}
          {profile.error ? <Alert severity="info">This account has no driver profile yet.</Alert> : null}
          {p ? (
            <>
              <Field label="Vehicle" value={vehicle} />
              <Field label="Plate" value={p.plateNumber ?? '—'} />
              <Field label="Working area" value={p.serviceArea ? `${(p.serviceArea.radiusMeters / 1000).toFixed(1)} km around ${p.serviceArea.lat.toFixed(3)}, ${p.serviceArea.lng.toFixed(3)}` : 'Anywhere'} />
              <Field label="Now" value={humanizeStatus(p.availability)} />
              <Field label="Last online" value={p.lastOnlineAt ? formatDateTime(p.lastOnlineAt) : 'Never'} />
              <Field label="Driver since" value={formatDate(p.createdAt)} />
            </>
          ) : null}
        </Box>

        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Documents
          </Typography>
          {documents.isLoading ? <Skeleton variant="rounded" height={90} /> : null}
          {documents.error ? <Alert severity="error">{message(documents.error, 'The documents could not be loaded.')}</Alert> : null}
          {documents.data && documents.data.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No documents on record.
            </Typography>
          ) : null}
          <Stack spacing={1.5}>
            {documents.data?.map((request) => (
              <Box key={request.requestId} sx={{ p: 1.5, borderRadius: 2, border: 1, borderColor: 'divider' }}>
                <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                  <Typography variant="body2">Submitted {formatDate(request.submittedAt)}</Typography>
                  <StatusChip status={request.status.toLowerCase()} />
                </Stack>
                {request.expiresAt ? <Field label="Valid until" value={formatDate(request.expiresAt)} /> : null}
                {request.documents.map((document, index) => (
                  <DocumentRow key={`${request.requestId}-${index}`} requestId={request.requestId} index={index} document={document} />
                ))}
              </Box>
            ))}
          </Stack>
        </Box>
      </Stack>

      <Dialog open={disabling} onClose={() => setDisabling(false)} fullWidth maxWidth="sm">
        <DialogTitle>Disable this driver?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            They are signed out at once, get no more delivery offers and cannot go online. Their records stay, and you can enable them again.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label="Reason (kept in the audit log)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            helperText={`${MIN_REASON_LENGTH}–${MAX_REASON_LENGTH} characters.`}
            inputProps={{ maxLength: MAX_REASON_LENGTH }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDisabling(false)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={!isValidReason(reason) || change.isPending} onClick={() => change.mutate('suspend')}>
            Disable driver
          </Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  );
}
