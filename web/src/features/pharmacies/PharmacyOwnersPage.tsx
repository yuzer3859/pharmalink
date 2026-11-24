import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { usePortal } from '@/hooks/usePortal';
import { ApiError } from '@/services/apiClient';
import { ownerChangeSummary, pharmacyOwnersService, type PharmacyOwner } from '@/services/pharmacyOwners.service';
import { formatDate } from '@/utils/format';
import { PharmacyRecord } from './PharmacyRecord';

const PAGE_SIZES = [10, 25, 50];
const message = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

function OwnerRecord({ userId, onClose, onOpenPharmacy }: { userId: string | null; onClose: () => void; onOpenPharmacy: (p: { pharmacyId: string; organizationId: string }) => void }) {
  const { can } = useAuth();
  const canManage = can('pharmacies:manage');
  const qc = useQueryClient();
  const notify = useNotify();
  const [dialog, setDialog] = useState<'disable' | 'enable' | null>(null);
  const [reason, setReason] = useState('');
  const [alsoPharmacies, setAlsoPharmacies] = useState(true);
  const { data: owner, isLoading, error } = useQuery({
    queryKey: ['pharmacy-owners', 'one', userId],
    queryFn: () => pharmacyOwnersService.get(userId as string),
    enabled: !!userId,
  });

  const change = useMutation({
    mutationFn: () =>
      dialog === 'disable'
        ? pharmacyOwnersService.disable(userId as string, reason, alsoPharmacies)
        : pharmacyOwnersService.enable(userId as string, alsoPharmacies),
    onSuccess: (result) => {
      const names = new Map((owner?.pharmacies ?? []).filter((p) => p.pharmacyId).map((p) => [p.pharmacyId as string, p.name]));
      const detail = ownerChangeSummary(result, names);
      notify(`${dialog === 'disable' ? 'Owner disabled.' : 'Owner enabled.'}${detail ? ` ${detail}.` : ''}`);
      qc.invalidateQueries({ queryKey: ['pharmacy-owners'] });
      qc.invalidateQueries({ queryKey: ['pharmacies'] });
      setDialog(null);
      setReason('');
    },
    onError: (e) => notify(message(e, 'The change could not be made.'), 'error'),
  });

  return (
    <Drawer anchor="right" open={!!userId} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', md: 560 } } }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" sx={{ p: 2.5, pb: 1.5 }}>
        <Box>
          <Typography variant="h5">{owner?.email ?? owner?.phone ?? 'Pharmacy owner'}</Typography>
          {owner ? (
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <StatusChip status={owner.status.toLowerCase()} />
            </Stack>
          ) : null}
        </Box>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>

      {owner && canManage ? (
        <Stack direction="row" spacing={1} sx={{ px: 2.5, pb: 1.5 }}>
          {owner.status === 'SUSPENDED' ? (
            <Button color="success" variant="contained" startIcon={<CheckCircleRoundedIcon />} onClick={() => setDialog('enable')}>
              Enable owner
            </Button>
          ) : (
            <Button color="error" variant="outlined" startIcon={<BlockRoundedIcon />} onClick={() => setDialog('disable')}>
              Disable owner
            </Button>
          )}
        </Stack>
      ) : null}
      <Divider />

      <Stack spacing={2} sx={{ p: 2.5 }}>
        {error ? <Alert severity="error">{message(error, 'The owner could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={160} /> : null}
        {owner ? (
          <>
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Account
              </Typography>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  E-mail
                </Typography>
                <Typography variant="body2">{owner.email ?? '—'}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  Phone
                </Typography>
                <Typography variant="body2">{owner.phone ?? '—'}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  Signed up
                </Typography>
                <Typography variant="body2">{formatDate(owner.createdAt)}</Typography>
              </Stack>
            </Box>
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Pharmacies they own ({owner.pharmacies.length})
              </Typography>
              <Stack spacing={1}>
                {owner.pharmacies.map((p) => (
                  <Stack key={p.organizationId} direction="row" alignItems="center" spacing={1.5} sx={{ p: 1.25, borderRadius: 2, border: 1, borderColor: 'divider' }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" noWrap>
                        {p.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {p.pharmacyId ? `Trading: ${(p.transactingStatus ?? '').toLowerCase()}` : 'No storefront yet'} · organisation {p.organizationStatus.toLowerCase().replace(/_/g, ' ')}
                      </Typography>
                    </Box>
                    {p.transactingStatus ? <StatusChip status={p.transactingStatus.toLowerCase()} /> : null}
                    {p.pharmacyId ? (
                      <Button size="small" onClick={() => onOpenPharmacy({ pharmacyId: p.pharmacyId as string, organizationId: p.organizationId })}>
                        Open
                      </Button>
                    ) : null}
                  </Stack>
                ))}
              </Stack>
            </Box>
          </>
        ) : null}
      </Stack>

      <Dialog open={dialog !== null} onClose={() => setDialog(null)} fullWidth maxWidth="sm">
        <DialogTitle>{dialog === 'disable' ? 'Disable this owner?' : 'Enable this owner again?'}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {dialog === 'disable'
              ? 'They are signed out at once and cannot sign in to the pharmacy portal. Their records stay.'
              : 'They can sign in again. A pharmacy is enabled again only if its licence is still approved and current.'}
          </Typography>
          {dialog === 'disable' ? (
            <TextField
              autoFocus
              fullWidth
              multiline
              minRows={3}
              label="Reason (kept in the history)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              helperText="3–500 characters."
              inputProps={{ maxLength: 500 }}
              sx={{ mb: 1 }}
            />
          ) : null}
          <FormControlLabel
            control={<Checkbox checked={alsoPharmacies} onChange={(e) => setAlsoPharmacies(e.target.checked)} />}
            label={dialog === 'disable' ? 'Also disable every pharmacy they own (customers can no longer buy from them)' : 'Also enable their pharmacies again'}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button
            variant="contained"
            color={dialog === 'disable' ? 'error' : 'success'}
            disabled={change.isPending || (dialog === 'disable' && reason.trim().length < 3)}
            onClick={() => change.mutate()}
          >
            {dialog === 'disable' ? 'Disable owner' : 'Enable owner'}
          </Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  );
}

/**
 * Work 157: pharmacy owners — the people who own one or more pharmacies (and run them through
 * their pharmacists). Each owner's record lists their pharmacies, opens any one's full record,
 * and disables or enables the owner (with their pharmacies, when chosen).
 */
export function PharmacyOwnersPage() {
  const portal = usePortal();
  const [identifier, setIdentifier] = useState('');
  const [status, setStatus] = useState('all');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);
  const [pharmacy, setPharmacy] = useState<{ pharmacyId: string; organizationId: string } | null>(null);

  const filters = useMemo(() => ({ identifier, status, page: paging.page + 1, size: paging.pageSize }), [identifier, status, paging]);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['pharmacy-owners', 'list', filters],
    queryFn: () => pharmacyOwnersService.list(filters),
    placeholderData: keepPreviousData,
  });

  const columns: GridColDef<PharmacyOwner>[] = [
    { field: 'email', headerName: 'E-mail', flex: 1.2, minWidth: 200, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'phone', headerName: 'Phone', width: 160, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'pharmacyCount', headerName: 'Pharmacies', width: 120 },
    { field: 'status', headerName: 'Account', width: 140, renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} /> },
    { field: 'createdAt', headerName: 'Signed up', width: 130, valueFormatter: (v: string) => formatDate(v) },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Pharmacy owners"
        subtitle="The people who own pharmacies. An owner may own several; their pharmacists run them. Open one to see their pharmacies or disable them."
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="Exact e-mail or phone"
          value={identifier}
          onChange={(e) => {
            setIdentifier(e.target.value);
            setPaging((p) => ({ ...p, page: 0 }));
          }}
          sx={{ minWidth: 260 }}
        />
        <TextField
          select
          size="small"
          label="Account"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPaging((p) => ({ ...p, page: 0 }));
          }}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="all">All</MenuItem>
          <MenuItem value="ACTIVE">Active</MenuItem>
          <MenuItem value="SUSPENDED">Disabled</MenuItem>
        </TextField>
      </Stack>
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {message(error, 'Owners could not be loaded.')}
        </Alert>
      ) : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as PharmacyOwner).userId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as PharmacyOwner).userId)}
        emptyTitle="No pharmacy owners found"
        emptyDescription="Owners appear here once a pharmacy is registered for them."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: PAGE_SIZES }}
      />

      <OwnerRecord key={selected ?? 'none'} userId={selected} onClose={() => setSelected(null)} onOpenPharmacy={setPharmacy} />
      <PharmacyRecord
        key={pharmacy?.pharmacyId ?? 'none-pharmacy'}
        pharmacyId={pharmacy?.pharmacyId ?? null}
        organizationId={pharmacy?.organizationId ?? null}
        onClose={() => setPharmacy(null)}
      />
    </>
  );
}
