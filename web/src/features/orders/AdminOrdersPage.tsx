import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Divider,
  Drawer,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useAdminOrder, useAdminOrders } from '@/hooks/useAdminOrders';
import { usePortal } from '@/hooks/usePortal';
import {
  ADMIN_ORDER_PAGE_SIZES,
  ADMIN_ORDER_STATUSES,
  fromMinorUnits,
  isOrderNumberFilter,
} from '@/services/adminOrders.service';
import { ApiError } from '@/services/apiClient';
import { currency, formatDateTime } from '@/utils/format';
import type { AdminOrderListItem, AdminOrderStatus } from '@/types';

type CodFilter = 'any' | 'cod' | 'prepaid';

const money = (minor: number, code: string) => currency(fromMinorUnits(minor), code);
const humanStatus = (status: string) => status.toLowerCase();

function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Your account is not allowed to view order operations.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return 'Orders could not be loaded.';
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ textAlign: 'right' }}>
        {value}
      </Typography>
    </Stack>
  );
}

function OrderDrawer({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const { data: order, isLoading, error } = useAdminOrder(orderId);
  return (
    <Drawer anchor="right" open={!!orderId} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 440 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">{order ? order.orderNumber : 'Order'}</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{loadErrorMessage(error)}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={240} /> : null}
        {order ? (
          <Stack spacing={1.25}>
            <StatusChip status={humanStatus(order.status)} />
            <Field label="Placed" value={order.placedAt ? formatDateTime(order.placedAt) : '—'} />
            <Field label="Payment" value={order.payment ? `${order.payment.method} · ${order.payment.status}` : 'None recorded'} />
            <Field label="Cash on delivery" value={order.isCod ? 'Yes' : 'No'} />
            <Divider />
            <Field label="Subtotal" value={money(order.subtotal, order.currency)} />
            <Field label="Delivery fee" value={money(order.deliveryFee, order.currency)} />
            <Field label="Platform fee" value={money(order.platformFee, order.currency)} />
            <Field label="Discounts" value={money(order.discountTotal, order.currency)} />
            <Field label="Total" value={money(order.grandTotal, order.currency)} />
            <Divider />
            <Typography variant="subtitle2">Fulfillments ({order.fulfillments.length})</Typography>
            {order.fulfillments.map((f) => (
              <Stack key={f.fulfillmentId} spacing={0.5} sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
                <Field label="Status" value={humanStatus(f.status)} />
                <Field label="Pharmacy" value={`${f.pharmacyId.slice(0, 8)}…`} />
                <Field label="Delivery job" value={f.deliveryJobId ? `${f.deliveryJobId.slice(0, 8)}…` : 'Not referenced'} />
              </Stack>
            ))}
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * Order operations for administrators (`GET /admin/operations/orders`, `order:read:any`):
 * read-only, no customer data, paged by the server. The pharmacy portal keeps its own Orders page.
 */
export function AdminOrdersPage() {
  const portal = usePortal();
  const [status, setStatus] = useState<AdminOrderStatus | 'all'>('all');
  const [cod, setCod] = useState<CodFilter>('any');
  const [orderNumber, setOrderNumber] = useState('');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: ADMIN_ORDER_PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);

  const orderNumberInvalid = orderNumber.trim() !== '' && !isOrderNumberFilter(orderNumber);
  const filters = useMemo(
    () => ({
      status,
      isCod: cod === 'any' ? undefined : cod === 'cod',
      orderNumber: orderNumberInvalid ? undefined : orderNumber,
      page: paging.page + 1,
      size: paging.pageSize,
    }),
    [status, cod, orderNumber, orderNumberInvalid, paging],
  );
  const { data, isLoading, isFetching, error } = useAdminOrders(filters);
  const resetPage = () => setPaging((p) => ({ ...p, page: 0 }));

  const columns: GridColDef<AdminOrderListItem>[] = [
    { field: 'orderNumber', headerName: 'Order', flex: 1, minWidth: 150 },
    {
      field: 'status',
      headerName: 'Status',
      width: 150,
      renderCell: ({ value }) => <StatusChip status={humanStatus(String(value))} />,
    },
    {
      field: 'grandTotal',
      headerName: 'Total',
      width: 130,
      valueGetter: (_v, row) => money(row.grandTotal, row.currency),
    },
    { field: 'isCod', headerName: 'COD', width: 80, valueFormatter: (v: boolean) => (v ? 'Yes' : 'No') },
    { field: 'lineCount', headerName: 'Lines', width: 80, type: 'number' },
    { field: 'fulfillmentCount', headerName: 'Fulfillments', width: 110, type: 'number' },
    {
      field: 'hasDeliveryJobReference',
      headerName: 'Delivery job',
      width: 120,
      valueFormatter: (v: boolean) => (v ? 'Referenced' : '—'),
    },
    {
      field: 'placedAt',
      headerName: 'Placed',
      width: 170,
      valueFormatter: (v: string | null) => (v ? formatDateTime(v) : '—'),
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Orders"
        subtitle="Platform-wide order operations. Read-only; customer details are not shown."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="Order number (exact)"
          value={orderNumber}
          error={orderNumberInvalid}
          helperText={orderNumberInvalid ? 'Letters, digits and hyphens only.' : undefined}
          onChange={(e) => {
            setOrderNumber(e.target.value);
            resetPage();
          }}
          sx={{ minWidth: 220 }}
        />
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as AdminOrderStatus | 'all');
            resetPage();
          }}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="all">All statuses</MenuItem>
          {ADMIN_ORDER_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {s.replace(/_/g, ' ').toLowerCase()}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Payment"
          value={cod}
          onChange={(e) => {
            setCod(e.target.value as CodFilter);
            resetPage();
          }}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="any">Any</MenuItem>
          <MenuItem value="cod">Cash on delivery</MenuItem>
          <MenuItem value="prepaid">Prepaid</MenuItem>
        </TextField>
      </Stack>

      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadErrorMessage(error)}
        </Alert>
      ) : null}

      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as AdminOrderListItem).orderId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as AdminOrderListItem).orderId)}
        emptyTitle="No orders found"
        emptyDescription="Orders matching your filters will appear here."
        server={{
          rowCount: data?.total ?? 0,
          paginationModel: paging,
          onPaginationModelChange: setPaging,
          pageSizeOptions: [...ADMIN_ORDER_PAGE_SIZES],
        }}
      />

      <OrderDrawer orderId={selected} onClose={() => setSelected(null)} />
    </>
  );
}
