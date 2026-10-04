import { useMemo, useState } from 'react';
import { Button, MenuItem, Rating, Stack, TextField } from '@mui/material';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { SearchInput } from '@/components/common/SearchInput';
import { usePharmacies, usePharmacyStatusMutation } from '@/hooks/usePharmacies';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { currency, formatDate } from '@/utils/format';
import type { Pharmacy } from '@/types';

export function PharmaciesPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const canManage = can('pharmacies:manage');

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Pharmacy['status'] | 'all'>('all');

  const filters = useMemo(() => ({ search, status }), [search, status]);
  const { data = [], isLoading } = usePharmacies(filters);
  const statusMutation = usePharmacyStatusMutation();

  const columns: GridColDef[] = [
    { field: 'name', headerName: 'Pharmacy', flex: 1.2, minWidth: 180 },
    { field: 'licenseNo', headerName: 'License', width: 150 },
    { field: 'city', headerName: 'City', width: 130 },
    {
      field: 'rating',
      headerName: 'Rating',
      width: 150,
      renderCell: (params) => (
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ height: '100%' }}>
          <Rating value={params.value as number} precision={0.1} size="small" readOnly />
        </Stack>
      ),
    },
    { field: 'ordersThisMonth', headerName: 'Orders (mo)', width: 110, type: 'number' },
    {
      field: 'revenueThisMonth',
      headerName: 'Revenue (mo)',
      width: 140,
      valueFormatter: (value: number) => currency(value),
    },
    {
      field: 'licenseExpiry',
      headerName: 'License expiry',
      width: 140,
      valueFormatter: (value: string) => formatDate(value),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      renderCell: (params) => <StatusChip status={params.value as string} />,
    },
    {
      field: 'actions',
      headerName: '',
      width: 150,
      sortable: false,
      filterable: false,
      renderCell: (params) => {
        const row = params.row as Pharmacy;
        if (!canManage) return null;
        if (row.status === 'active') {
          return (
            <Button
              size="small"
              color="error"
              startIcon={<BlockRoundedIcon />}
              onClick={() => statusMutation.mutate({ id: row.id, status: 'suspended' })}
            >
              Suspend
            </Button>
          );
        }
        return (
          <Button
            size="small"
            color="success"
            startIcon={<CheckCircleRoundedIcon />}
            onClick={() => statusMutation.mutate({ id: row.id, status: 'active' })}
          >
            {row.status === 'pending' ? 'Approve' : 'Activate'}
          </Button>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Pharmacies"
        subtitle="Onboard, verify and manage pharmacies operating on the platform."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search name or city" />
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as Pharmacy['status'] | 'all')}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="all">All statuses</MenuItem>
          <MenuItem value="active">Active</MenuItem>
          <MenuItem value="pending">Pending</MenuItem>
          <MenuItem value="suspended">Suspended</MenuItem>
        </TextField>
      </Stack>

      <DataTable
        rows={data}
        columns={columns}
        loading={isLoading}
        emptyTitle="No pharmacies found"
        emptyDescription="Pharmacies matching your filters will appear here."
      />
    </>
  );
}
