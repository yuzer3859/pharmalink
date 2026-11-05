import { useMemo, useState } from 'react';
import { Alert, Box, Divider, Drawer, Grid, IconButton, MenuItem, Skeleton, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { StatCard } from '@/components/common/StatCard';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import {
  adminFinanceService,
  FINANCE_PAGE_SIZES,
  financeErrorMessage,
  isUuid,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
  SETTLEMENT_STATUSES,
} from '@/services/adminFinance.service';
import { humanizeStatus } from '@/services/adminAnalytics.service';
import { fromMinorUnits } from '@/services/adminOrders.service';
import { currency, formatDate, formatDateTime } from '@/utils/format';
import { SettlementDrawer } from './SettlementDrawer';
import { RefundForm } from './RefundForm';
import type {
  FinancePayment,
  FinanceRefund,
  FinancePaymentMethod,
  FinancePaymentStatus,
  RefundStatus,
  Settlement,
  SettlementStatus,
} from '@/types';

const money = (minor: number, code = 'ETB') => currency(fromMinorUnits(minor), code);
const shortId = (id: string | null) => (id ? `${id.slice(0, 8)}…` : '—');
const chip = (value: unknown) => <StatusChip status={String(value).toLowerCase()} />;
const firstPage = (size: number): GridPaginationModel => ({ page: 0, pageSize: size });

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

function StatusSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T | 'all'; options: T[]; onChange: (v: T | 'all') => void }) {
  return (
    <TextField select size="small" label={label} value={value} onChange={(e) => onChange(e.target.value as T | 'all')} sx={{ minWidth: 180 }}>
      <MenuItem value="all">All</MenuItem>
      {options.map((o) => (
        <MenuItem key={o} value={o}>
          {humanizeStatus(o)}
        </MenuItem>
      ))}
    </TextField>
  );
}

function OverviewTab() {
  const { data, isLoading, error } = useQuery({ queryKey: ['admin-finance', 'overview'] as const, queryFn: () => adminFinanceService.overview() });
  if (error) return <Alert severity="error">{financeErrorMessage(error, 'The finance overview could not be loaded.')}</Alert>;
  if (isLoading || !data) return <Skeleton variant="rounded" height={260} />;
  const rows = (items: Array<{ currency: string; status: string; count: number; amount: number }>) =>
    items.length === 0 ? (
      <Typography variant="body2" color="text.secondary">
        None yet.
      </Typography>
    ) : (
      items.map((r) => <Field key={`${r.currency}-${r.status}`} label={`${humanizeStatus(r.status)} (${r.count})`} value={money(r.amount, r.currency)} />)
    );
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Snapshot generated {formatDateTime(data.generatedAt)}.
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <Box sx={{ p: 2, borderRadius: 1, bgcolor: 'action.hover' }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Payments by status
            </Typography>
            {rows(data.payments.byStatus)}
          </Box>
        </Grid>
        <Grid item xs={12} md={4}>
          <Box sx={{ p: 2, borderRadius: 1, bgcolor: 'action.hover' }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Refunds by status
            </Typography>
            {rows(data.refunds.byStatus)}
          </Box>
        </Grid>
        <Grid item xs={12} md={4}>
          <Box sx={{ p: 2, borderRadius: 1, bgcolor: 'action.hover' }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Settlements (net payable)
            </Typography>
            {data.settlements.byStatus.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                None yet.
              </Typography>
            ) : (
              data.settlements.byStatus.map((s) => (
                <Field key={`${s.currency}-${s.status}`} label={`${humanizeStatus(s.status)} (${s.count})`} value={money(s.netPayable, s.currency)} />
              ))
            )}
          </Box>
        </Grid>
      </Grid>
      <Grid container spacing={2}>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard label={`COD expected (${data.cod.count})`} value={money(data.cod.expectedAmount)} />
        </Grid>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard label="COD collected" value={money(data.cod.collectedAmount)} />
        </Grid>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard label="COD remitted" value={money(data.cod.remittedAmount)} />
        </Grid>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard label={`COD outstanding (${data.cod.outstandingCount})`} value={money(data.cod.outstandingAmount)} />
        </Grid>
      </Grid>
    </Stack>
  );
}

function PaymentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-finance', 'payment', id] as const,
    queryFn: () => adminFinanceService.payment(id as string),
    enabled: !!id,
  });
  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 460 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">Payment</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{financeErrorMessage(error, 'The payment could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={240} /> : null}
        {data ? (
          <Stack spacing={1.25}>
            {chip(data.payment.status)}
            <Field label="Amount" value={money(data.payment.amount, data.payment.currency)} />
            <Field label="Method" value={humanizeStatus(data.payment.method)} />
            <Field label="Provider" value={data.payment.provider ?? '—'} />
            <Field label="Order" value={data.payment.orderId} />
            <Field label="Captured" value={data.payment.capturedAt ? formatDateTime(data.payment.capturedAt) : '—'} />
            {data.payment.failureReason ? <Field label="Failure" value={data.payment.failureReason} /> : null}
            <Divider />
            <Field label="Captured amount" value={money(data.refunds.capturedAmount, data.payment.currency)} />
            <Field label="Refunded" value={money(data.refunds.totalRefunded, data.payment.currency)} />
            <Field label="Still refundable" value={money(data.refunds.remainingRefundable, data.payment.currency)} />
            {data.refunds.refunds.map((r) => (
              <Box key={r.refundId} sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
                <Field label={`${humanizeStatus(r.type)} refund · ${humanizeStatus(r.status)}`} value={money(r.amount, r.currency)} />
                <Typography variant="caption" color="text.secondary">
                  {formatDateTime(r.createdAt)}
                  {r.reason ? ` · ${r.reason}` : ''}
                </Typography>
              </Box>
            ))}
            {can('finance:refund') ? (
              <>
                <Divider />
                <RefundForm paymentId={data.payment.paymentId} remaining={data.refunds.remainingRefundable} currency={data.payment.currency} />
              </>
            ) : null}
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

function PaymentsTab() {
  const [status, setStatus] = useState<FinancePaymentStatus | 'all'>('all');
  const [method, setMethod] = useState<FinancePaymentMethod | 'all'>('all');
  const [orderId, setOrderId] = useState('');
  const [paging, setPaging] = useState(firstPage(FINANCE_PAGE_SIZES[1]));
  const [selected, setSelected] = useState<string | null>(null);
  const orderInvalid = orderId.trim() !== '' && !isUuid(orderId);
  const filters = useMemo(() => ({ status, method, orderId, page: paging.page + 1, size: paging.pageSize }), [status, method, orderId, paging]);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-finance', 'payments', filters] as const,
    queryFn: () => adminFinanceService.payments(filters),
    placeholderData: keepPreviousData,
  });
  const reset = () => setPaging((p) => ({ ...p, page: 0 }));
  const columns: GridColDef<FinancePayment>[] = [
    { field: 'createdAt', headerName: 'Created', width: 170, valueFormatter: (v: string) => formatDateTime(v) },
    { field: 'amount', headerName: 'Amount', width: 130, valueGetter: (_v, row) => money(row.amount, row.currency) },
    { field: 'method', headerName: 'Method', width: 140, valueFormatter: (v: string) => humanizeStatus(v) },
    { field: 'status', headerName: 'Status', width: 170, renderCell: ({ value }) => chip(value) },
    { field: 'provider', headerName: 'Provider', width: 130, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'orderId', headerName: 'Order', width: 120, valueFormatter: (v: string) => shortId(v) },
  ];
  return (
    <>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <StatusSelect label="Status" value={status} options={PAYMENT_STATUSES} onChange={(v) => { setStatus(v); reset(); }} />
        <StatusSelect label="Method" value={method} options={PAYMENT_METHODS} onChange={(v) => { setMethod(v); reset(); }} />
        <TextField size="small" label="Order id" value={orderId} error={orderInvalid} helperText={orderInvalid ? 'Enter a full order id (UUID).' : undefined}
          onChange={(e) => { setOrderId(e.target.value); reset(); }} sx={{ minWidth: 300 }} />
      </Stack>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{financeErrorMessage(error, 'Payments could not be loaded.')}</Alert> : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as FinancePayment).paymentId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as FinancePayment).paymentId)}
        emptyTitle="No payments"
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: [...FINANCE_PAGE_SIZES] }}
      />
      <PaymentDrawer id={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function RefundsTab() {
  const [status, setStatus] = useState<RefundStatus | 'all'>('all');
  const [paging, setPaging] = useState(firstPage(FINANCE_PAGE_SIZES[1]));
  const filters = useMemo(() => ({ status, page: paging.page + 1, size: paging.pageSize }), [status, paging]);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-finance', 'refunds', filters] as const,
    queryFn: () => adminFinanceService.refunds(filters),
    placeholderData: keepPreviousData,
  });
  const columns: GridColDef<FinanceRefund>[] = [
    { field: 'createdAt', headerName: 'Requested', width: 170, valueFormatter: (v: string) => formatDateTime(v) },
    { field: 'amount', headerName: 'Amount', width: 130, valueGetter: (_v, row) => money(row.amount, row.currency) },
    { field: 'type', headerName: 'Type', width: 100, valueFormatter: (v: string) => humanizeStatus(v) },
    { field: 'destination', headerName: 'Destination', width: 120, valueFormatter: (v: string) => humanizeStatus(v) },
    { field: 'status', headerName: 'Status', width: 130, renderCell: ({ value }) => chip(value) },
    { field: 'reason', headerName: 'Reason', flex: 1, minWidth: 180, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'paymentId', headerName: 'Payment', width: 120, valueFormatter: (v: string) => shortId(v) },
  ];
  return (
    <>
      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
        <StatusSelect label="Status" value={status} options={REFUND_STATUSES} onChange={(v) => { setStatus(v); setPaging((p) => ({ ...p, page: 0 })); }} />
      </Stack>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{financeErrorMessage(error, 'Refunds could not be loaded.')}</Alert> : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as FinanceRefund).refundId}
        loading={isLoading || isFetching}
        emptyTitle="No refunds"
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: [...FINANCE_PAGE_SIZES] }}
      />
    </>
  );
}

function SettlementsTab() {
  const [status, setStatus] = useState<SettlementStatus | 'all'>('all');
  const [paging, setPaging] = useState(firstPage(FINANCE_PAGE_SIZES[1]));
  const [selected, setSelected] = useState<Settlement | null>(null);
  const filters = useMemo(() => ({ status, page: paging.page + 1, size: paging.pageSize }), [status, paging]);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-finance', 'settlements', filters] as const,
    queryFn: () => adminFinanceService.settlements(filters),
    placeholderData: keepPreviousData,
  });
  const columns: GridColDef<Settlement>[] = [
    { field: 'statementRef', headerName: 'Statement', width: 170 },
    { field: 'pharmacyId', headerName: 'Pharmacy', width: 120, valueFormatter: (v: string) => shortId(v) },
    { field: 'periodStart', headerName: 'Period', width: 210, valueGetter: (_v, row) => `${formatDate(row.periodStart)} – ${formatDate(row.periodEnd)}` },
    { field: 'netPayable', headerName: 'Net payable', width: 140, valueGetter: (_v, row) => money(row.netPayable, row.currency) },
    { field: 'platformRevenue', headerName: 'Platform revenue', width: 150, valueGetter: (_v, row) => money(row.platformRevenue, row.currency) },
    { field: 'lineCount', headerName: 'Lines', width: 80, type: 'number' },
    { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => chip(value) },
  ];
  return (
    <>
      <Alert severity="info" sx={{ mb: 2 }}>
        Open a statement to approve it, register or verify the pharmacy's payout destination, and pay it
        out. Approving, paying and verifying need a second finance officer (Approvals page).
      </Alert>
      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
        <StatusSelect label="Status" value={status} options={SETTLEMENT_STATUSES} onChange={(v) => { setStatus(v); setPaging((p) => ({ ...p, page: 0 })); }} />
      </Stack>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{financeErrorMessage(error, 'Settlements could not be loaded.')}</Alert> : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as Settlement).settlementId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected(row as Settlement)}
        emptyTitle="No settlements"
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: [...FINANCE_PAGE_SIZES] }}
      />
      <SettlementDrawer key={selected?.settlementId ?? 'none'} settlement={selected} onClose={() => setSelected(null)} />
    </>
  );
}

type FinanceTab = 'overview' | 'payments' | 'refunds' | 'settlements';

/**
 * Financial oversight (module-16 §9.5): the overview, payments with their refunds, and refunds
 * (`finance:report:any`), plus settlements for accounts with `finance:settlement:any`. Read-only.
 */
export function FinancePage() {
  const portal = usePortal();
  const { can } = useAuth();
  const [tab, setTab] = useState<FinanceTab>('overview');
  const showSettlements = can('finance:settle');
  return (
    <>
      <PageHeader portalName={portal.title} title="Finance" subtitle="Payments, refunds and settlements. Amounts in birr." />
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tabs value={tab} onChange={(_e, v: FinanceTab) => setTab(v)}>
          <Tab value="overview" label="Overview" />
          <Tab value="payments" label="Payments" />
          <Tab value="refunds" label="Refunds" />
          {showSettlements ? <Tab value="settlements" label="Settlements" /> : null}
        </Tabs>
      </Box>
      {tab === 'overview' ? <OverviewTab /> : null}
      {tab === 'payments' ? <PaymentsTab /> : null}
      {tab === 'refunds' ? <RefundsTab /> : null}
      {tab === 'settlements' && showSettlements ? <SettlementsTab /> : null}
    </>
  );
}
