import { useMemo, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { financeErrorMessage } from '@/services/adminFinance.service';
import { fromMinorUnits } from '@/services/adminOrders.service';
import { birrToSantim, COD_STATUSES, financeCodService, REFERENCE_MAX, remitProblem, type CodCollection, type CodStatus } from '@/services/financeCod.service';
import { currency, formatDateTime } from '@/utils/format';

const money = (minor: number, code = 'ETB') => currency(fromMinorUnits(minor), code);
const shortId = (id: string) => `${id.slice(0, 8)}…`;
const STATUS_TEXT: Record<CodStatus, string> = { COLLECTED: 'with the driver', REMITTED: 'received', RECONCILED: 'reconciled' };

function RemitDialog({ collection, onClose }: { collection: CodCollection; onClose: () => void }) {
  const notify = useNotify();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(String(fromMinorUnits(collection.collectedAmount)));
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const problem = remitProblem(amount, reference);
  const remit = useMutation({
    mutationFn: () => financeCodService.remit(collection.id, { remittedAmount: birrToSantim(amount)!, reference, note }),
    onSuccess: () => {
      notify('Cash received recorded. The sale is now payable to the pharmacy and appears in its next statement.');
      onClose();
    },
    onError: (e) => notify(financeErrorMessage(e, 'The cash could not be recorded.'), 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin-finance'] }),
  });
  const differs = birrToSantim(amount) !== null && birrToSantim(amount) !== collection.collectedAmount;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Record cash received</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            The driver collected {money(collection.collectedAmount, collection.currency)} on order {shortId(collection.orderId)} ({formatDateTime(collection.collectedAt)}). Record what PharmaLink actually received.
          </Typography>
          <TextField size="small" label="Cash received (birr)" value={amount} onChange={(e) => setAmount(e.target.value)} inputProps={{ inputMode: 'decimal' }} />
          {differs ? <Alert severity="warning">This differs from what the driver collected; the difference is recorded as a discrepancy.</Alert> : null}
          <TextField size="small" label="Receipt or deposit reference" value={reference} onChange={(e) => setReference(e.target.value)} inputProps={{ maxLength: REFERENCE_MAX }} />
          <TextField size="small" label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} inputProps={{ maxLength: 500 }} multiline minRows={2} />
          {problem && reference !== '' ? <Typography variant="caption" color="text.secondary">{problem}</Typography> : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!!problem || remit.isPending} onClick={() => remit.mutate()}>
          Record received
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Work 127: COD cash, from the driver to PharmaLink. Record the cash received (which makes the COD
 * sale payable to the pharmacy, the owner's COD rule) and reconcile it once checked.
 */
export function CodCashTab() {
  const { can } = useAuth();
  const notify = useNotify();
  const qc = useQueryClient();
  const [status, setStatus] = useState<CodStatus | 'all'>('COLLECTED');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [remitting, setRemitting] = useState<CodCollection | null>(null);
  const filters = useMemo(() => ({ status, page: paging.page + 1, size: paging.pageSize }), [status, paging]);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-finance', 'cod-cash', filters] as const,
    queryFn: () => financeCodService.list(filters),
    placeholderData: keepPreviousData,
  });
  const reconcile = useMutation({
    mutationFn: (id: string) => financeCodService.reconcile(id),
    onSuccess: () => notify('Reconciled.'),
    onError: (e) => notify(financeErrorMessage(e, 'The collection could not be reconciled.'), 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin-finance'] }),
  });

  const columns: GridColDef<CodCollection>[] = [
    { field: 'orderId', headerName: 'Order', width: 120, valueFormatter: (v: string) => shortId(v) },
    { field: 'driverId', headerName: 'Driver', width: 120, valueFormatter: (v: string) => shortId(v) },
    { field: 'collectedAmount', headerName: 'Collected', width: 120, valueGetter: (_v, row) => money(row.collectedAmount, row.currency) },
    { field: 'received', headerName: 'Received', width: 120, valueGetter: (_v, row) => (row.remittance ? money(row.remittance.remittedAmount, row.currency) : '—') },
    { field: 'status', headerName: 'Cash', width: 140, renderCell: ({ row }) => <StatusChip status={STATUS_TEXT[row.status] ?? row.status.toLowerCase()} /> },
    { field: 'collectedAt', headerName: 'Collected at', width: 170, valueFormatter: (v: string) => formatDateTime(v) },
    {
      field: 'actions',
      headerName: '',
      width: 190,
      sortable: false,
      renderCell: ({ row }) =>
        !can('finance:settle') ? null : row.status === 'COLLECTED' ? (
          <Button size="small" variant="contained" onClick={() => setRemitting(row)}>Record cash received</Button>
        ) : row.status === 'REMITTED' ? (
          <Button size="small" disabled={reconcile.isPending} onClick={() => reconcile.mutate(row.id)}>Reconcile</Button>
        ) : null,
    },
  ];

  return (
    <Stack spacing={2}>
      <Alert severity="info">
        A pharmacy is paid for a cash-on-delivery order only once its cash reaches PharmaLink. Record the cash when a driver hands it over; the sale then appears in the pharmacy’s next statement.
      </Alert>
      <TextField select size="small" label="Cash" value={status} onChange={(e) => { setStatus(e.target.value as CodStatus | 'all'); setPaging((p) => ({ ...p, page: 0 })); }} sx={{ maxWidth: 220 }}>
        <MenuItem value="all">All</MenuItem>
        {COD_STATUSES.map((s) => (
          <MenuItem key={s} value={s}>{STATUS_TEXT[s]}</MenuItem>
        ))}
      </TextField>
      {error ? <Alert severity="error">{financeErrorMessage(error, 'COD cash could not be loaded.')}</Alert> : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as CodCollection).id}
        loading={isLoading || isFetching}
        emptyTitle="Nothing here"
        emptyDescription="Cash collected on COD deliveries appears here."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: [10, 25, 50] }}
      />
      {remitting ? <RemitDialog collection={remitting} onClose={() => setRemitting(null)} /> : null}
    </Stack>
  );
}
