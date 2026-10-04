import { useMemo, useState } from 'react';
import { IconButton, MenuItem, Stack, TextField, Tooltip } from '@mui/material';
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { SearchInput } from '@/components/common/SearchInput';
import { OrderDetailDrawer } from './OrderDetailDrawer';
import { useOrders } from '@/hooks/useOrders';
import { usePortal } from '@/hooks/usePortal';
import { currency, formatDateTime } from '@/utils/format';
import type { Order, OrderStatus } from '@/types';

const STATUS_OPTIONS: Array<{ value: OrderStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'placed', label: 'Placed' },
  { value: 'verified', label: 'Verified' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function OrdersPage() {
  const portal = usePortal();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [selected, setSelected] = useState<Order | null>(null);

  const filters = useMemo(() => ({ search, status }), [search, status]);
  const { data = [], isLoading } = useOrders(filters);

  const columns: GridColDef[] = [
    { field: 'reference', headerName: 'Reference', flex: 1, minWidth: 150 },
    { field: 'customerName', headerName: 'Customer', flex: 1, minWidth: 140 },
    ...(portal.key !== 'pharmacy'
      ? [{ field: 'pharmacyName', headerName: 'Pharmacy', flex: 1, minWidth: 150 } as GridColDef]
      : []),
    { field: 'itemCount', headerName: 'Items', width: 90, type: 'number' },
    {
      field: 'total',
      headerName: 'Total',
      width: 120,
      valueFormatter: (value: number) => currency(value),
    },
    {
      field: 'paymentStatus',
      headerName: 'Payment',
      width: 130,
      renderCell: (params) => <StatusChip status={params.value as string} />,
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 130,
      renderCell: (params) => <StatusChip status={params.value as string} />,
    },
    {
      field: 'createdAt',
      headerName: 'Placed',
      width: 170,
      valueFormatter: (value: string) => formatDateTime(value),
    },
    {
      field: 'actions',
      headerName: '',
      width: 70,
      sortable: false,
      filterable: false,
      renderCell: (params) => (
        <Tooltip title="View details">
          <IconButton size="small" onClick={() => setSelected(params.row as Order)}>
            <VisibilityRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Orders"
        subtitle="Monitor and progress orders through the fulfilment lifecycle."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search reference or customer" />
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as OrderStatus | 'all')}
          sx={{ minWidth: 180 }}
        >
          {STATUS_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      <DataTable
        rows={data}
        columns={columns}
        loading={isLoading}
        pageSize={25}
        emptyTitle="No orders found"
        emptyDescription="Orders matching your filters will appear here."
      />

      <OrderDetailDrawer orderId={selected?.id ?? null} onClose={() => setSelected(null)} />
    </>
  );
}
