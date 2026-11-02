import { useMemo, useState } from 'react';
import { Alert, Box, Button, Divider, Drawer, IconButton, Skeleton, Stack, TextField, Typography, MenuItem } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { usePortal } from '@/hooks/usePortal';
import {
  adminFinanceService,
  DISPUTE_STATUSES,
  FINANCE_PAGE_SIZES,
  financeErrorMessage,
  isUuid,
  MAX_RESOLUTION_NOTE_LENGTH,
} from '@/services/adminFinance.service';
import { humanizeStatus } from '@/services/adminAnalytics.service';
import { fromMinorUnits } from '@/services/adminOrders.service';
import { currency, formatDateTime } from '@/utils/format';
import type { CodDisputePage, CodDisputeStatus } from '@/types';

type Row = CodDisputePage['items'][number];
const money = (minor: number, code = 'ETB') => currency(fromMinorUnits(minor), code);
const shortId = (id: string) => `${id.slice(0, 8)}…`;

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ textAlign: 'right', wordBreak: 'break-all' }}>
        {value}
      </Typography>
    </Stack>
  );
}

function DisputeDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const notify = useNotify();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-disputes', 'detail', id] as const,
    queryFn: () => adminFinanceService.dispute(id as string),
    enabled: !!id,
  });
  const resolve = useMutation({
    mutationFn: () => adminFinanceService.resolveDispute(id as string, note),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['admin-disputes'] });
      notify(result.changed ? 'Dispute resolved.' : 'The dispute was already resolved.');
      onClose();
    },
    onError: (e) => notify(financeErrorMessage(e, 'The dispute could not be resolved.'), 'error'),
  });

  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 480 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">COD dispute</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{financeErrorMessage(error, 'The dispute could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={260} /> : null}
        {data ? (
          <Stack spacing={1.25}>
            <StatusChip status={data.dispute.status.toLowerCase()} />
            <Field label="Reason" value={data.dispute.reason} />
            <Field label="Opened" value={formatDateTime(data.dispute.openedAt)} />
            {data.dispute.resolvedAt ? <Field label="Resolved" value={formatDateTime(data.dispute.resolvedAt)} /> : null}
            {data.dispute.resolutionNote ? <Field label="Resolution" value={data.dispute.resolutionNote} /> : null}
            <Divider />
            <Typography variant="subtitle2">Collection</Typography>
            <Field label="Expected" value={money(data.collection.expectedAmount, data.collection.currency)} />
            <Field label="Collected" value={money(data.collection.collectedAmount, data.collection.currency)} />
            <Field label="Collection variance" value={money(data.collection.collectionVariance, data.collection.currency)} />
            <Field
              label="Remitted"
              value={data.collection.remittance ? `${money(data.collection.remittance.remittedAmount, data.collection.currency)} · ${data.collection.remittance.reference}` : 'Not yet'}
            />
            <Field label="Reconciliation" value={data.collection.reconciliation ? humanizeStatus(data.collection.reconciliation.outcome) : 'Not yet'} />
            <Field label="Discrepancy" value={data.collection.hasDiscrepancy ? 'Yes' : 'No'} />
            <Field label="Order" value={data.collection.orderId} />
            <Field label="Driver" value={data.collection.driverId} />
            {data.collection.corrections.length > 0 ? <Field label="Corrections" value={String(data.collection.corrections.length)} /> : null}

            {data.dispute.status === 'OPEN' && can('finance:settle') ? (
              <>
                <Divider />
                <TextField
                  size="small"
                  multiline
                  minRows={2}
                  label="Resolution note (optional, audited)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  inputProps={{ maxLength: MAX_RESOLUTION_NOTE_LENGTH }}
                />
                <Button variant="contained" disabled={resolve.isPending} onClick={() => resolve.mutate()}>
                  Mark resolved
                </Button>
              </>
            ) : null}
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * COD disputes (`/admin/cod-disputes`): open and resolved disputes on cash-on-delivery collections
 * (`finance:report:any`), resolved with an optional audited note (`finance:settlement:any`).
 */
export function CodDisputesPage() {
  const portal = usePortal();
  const [status, setStatus] = useState<CodDisputeStatus | 'all'>('OPEN');
  const [orderId, setOrderId] = useState('');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: FINANCE_PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);
  const orderInvalid = orderId.trim() !== '' && !isUuid(orderId);
  const filters = useMemo(() => ({ status, orderId, page: paging.page + 1, size: paging.pageSize }), [status, orderId, paging]);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-disputes', filters] as const,
    queryFn: () => adminFinanceService.disputes(filters),
    placeholderData: keepPreviousData,
  });
  const reset = () => setPaging((p) => ({ ...p, page: 0 }));

  const columns: GridColDef<Row>[] = [
    { field: 'openedAt', headerName: 'Opened', width: 170, valueGetter: (_v, row) => formatDateTime(row.dispute.openedAt) },
    { field: 'status', headerName: 'Status', width: 120, renderCell: ({ row }) => <StatusChip status={row.dispute.status.toLowerCase()} /> },
    { field: 'reason', headerName: 'Reason', flex: 1, minWidth: 200, valueGetter: (_v, row) => row.dispute.reason },
    { field: 'expected', headerName: 'Expected', width: 130, valueGetter: (_v, row) => money(row.collection.expectedAmount, row.collection.currency) },
    { field: 'collected', headerName: 'Collected', width: 130, valueGetter: (_v, row) => money(row.collection.collectedAmount, row.collection.currency) },
    { field: 'orderId', headerName: 'Order', width: 120, valueGetter: (_v, row) => shortId(row.collection.orderId) },
  ];

  return (
    <>
      <PageHeader portalName={portal.title} title="COD disputes" subtitle="Disputes on cash-on-delivery collections." />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField select size="small" label="Status" value={status} onChange={(e) => { setStatus(e.target.value as CodDisputeStatus | 'all'); reset(); }} sx={{ minWidth: 160 }}>
          <MenuItem value="all">All</MenuItem>
          {DISPUTE_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {humanizeStatus(s)}
            </MenuItem>
          ))}
        </TextField>
        <TextField size="small" label="Order id" value={orderId} error={orderInvalid} helperText={orderInvalid ? 'Enter a full order id (UUID).' : undefined}
          onChange={(e) => { setOrderId(e.target.value); reset(); }} sx={{ minWidth: 300 }} />
      </Stack>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{financeErrorMessage(error, 'Disputes could not be loaded.')}</Alert> : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as Row).dispute.id}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as Row).dispute.id)}
        emptyTitle="No disputes"
        emptyDescription="Disputes matching your filters will appear here."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: [...FINANCE_PAGE_SIZES] }}
      />
      <DisputeDrawer key={selected ?? 'none'} id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
