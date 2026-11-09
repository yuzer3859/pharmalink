import { useState } from 'react';
import { Alert, Box, Divider, Drawer, IconButton, MenuItem, Skeleton, Stack, TextField, Typography } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { usePortal } from '@/hooks/usePortal';
import { dashboardErrorMessage, useStatement, useStatements } from '@/hooks/usePharmacyDashboard';
import { fromMinorUnits } from '@/services/adminOrders.service';
import type { Statement } from '@/services/pharmacyDashboard.service';
import { currency, formatDate, formatDateTime } from '@/utils/format';

const money = (minor: number, code: string) => currency(fromMinorUnits(minor), code);
const STATUSES = ['DRAFT', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED'];

function StatementDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: s, isLoading, error } = useStatement(id);
  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 500 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">{s?.statementRef ?? 'Statement'}</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{dashboardErrorMessage(error, 'The statement could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={240} /> : null}
        {s ? (
          <Stack spacing={1.25}>
            <StatusChip status={s.status.toLowerCase()} />
            <Typography variant="body2" color="text.secondary">
              {formatDate(s.periodStart)} – {formatDate(s.periodEnd)}
            </Typography>
            <Stack direction="row" justifyContent="space-between"><Typography variant="body2">Sales payable to you</Typography><Typography variant="body2">{money(s.providerPayableGross, s.currency)}</Typography></Stack>
            <Stack direction="row" justifyContent="space-between"><Typography variant="body2">Refund clawback</Typography><Typography variant="body2">−{money(s.refundClawback, s.currency)}</Typography></Stack>
            <Stack direction="row" justifyContent="space-between"><Typography variant="subtitle2">Net payable</Typography><Typography variant="subtitle2">{money(s.netPayable, s.currency)}</Typography></Stack>
            <Divider />
            <Typography variant="subtitle2">Lines ({s.lines.length})</Typography>
            {s.lines.map((l) => (
              <Stack key={l.ledgerReference} direction="row" justifyContent="space-between" spacing={2}>
                <Typography variant="body2">{l.transactionType.replace(/_/g, ' ').toLowerCase()} · {formatDateTime(l.occurredAt)}</Typography>
                <Typography variant="body2">{money(l.providerPayableDelta, s.currency)}</Typography>
              </Stack>
            ))}
            <Typography variant="caption" color="text.secondary">
              Cash-on-delivery sales appear once the driver’s cash has reached PharmaLink. Payouts are approved by two PharmaLink finance officers.
            </Typography>
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * Work 116: the pharmacy's settlement statements (`GET /settlements`, `settlement:read:org`),
 * read-only. Replaces the earlier in-memory report generator, which no API backed.
 */
export function ReportsPage() {
  const portal = usePortal();
  const [status, setStatus] = useState('all');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, isFetching, error } = useStatements({ status, page: paging.page + 1, size: paging.pageSize });

  const columns: GridColDef<Statement>[] = [
    { field: 'statementRef', headerName: 'Statement', flex: 1, minWidth: 170 },
    { field: 'period', headerName: 'Period', width: 220, valueGetter: (_v, row) => `${formatDate(row.periodStart)} – ${formatDate(row.periodEnd)}` },
    { field: 'netPayable', headerName: 'Net payable', width: 140, valueGetter: (_v, row) => money(row.netPayable, row.currency) },
    { field: 'lineCount', headerName: 'Lines', width: 80, type: 'number' },
    { field: 'status', headerName: 'Status', width: 130, renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} /> },
  ];

  return (
    <>
      <PageHeader portalName={portal.title} title="Statements" subtitle="What PharmaLink owes your pharmacy, statement by statement." />
      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
        <TextField select size="small" label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPaging((p) => ({ ...p, page: 0 })); }} sx={{ minWidth: 180 }}>
          <MenuItem value="all">All statuses</MenuItem>
          {STATUSES.map((s) => (
            <MenuItem key={s} value={s}>{s.toLowerCase()}</MenuItem>
          ))}
        </TextField>
      </Stack>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{dashboardErrorMessage(error, 'Statements could not be loaded.')}</Alert> : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as Statement).settlementId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as Statement).settlementId)}
        emptyTitle="No statements yet"
        emptyDescription="Statements appear once PharmaLink settles your pharmacy’s sales."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: [10, 25, 50] }}
      />
      <StatementDrawer id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
