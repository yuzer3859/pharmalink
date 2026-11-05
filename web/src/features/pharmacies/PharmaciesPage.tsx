import { useMemo, useState } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useActivatePharmacy, usePharmacies } from '@/hooks/usePharmacies';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { PHARMACY_PAGE_SIZES } from '@/services/pharmacies.service';
import { ApiError } from '@/services/apiClient';
import { formatDate } from '@/utils/format';
import type { PharmacyOperations, TransactingStatus } from '@/types';

type Flag = 'any' | 'yes' | 'no';
const toFlag = (value: Flag) => (value === 'any' ? undefined : value === 'yes');

function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Your account is not allowed to view pharmacy operations.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return 'Pharmacies could not be loaded.';
}

/**
 * Live pharmacies from `GET /admin/operations/pharmacies` (read-only, `pharmacy:read:any`), with
 * the one operator action the backend has: `POST /pharmacy/activate` (`provider:verify:any`). The
 * server decides eligibility; the portal only asks.
 */
export function PharmaciesPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const canActivate = can('pharmacies:manage');

  const [status, setStatus] = useState<TransactingStatus | 'all'>('all');
  const [eligible, setEligible] = useState<Flag>('any');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: PHARMACY_PAGE_SIZES[1] });

  const filters = useMemo(
    () => ({ transactingStatus: status, eligible: toFlag(eligible), page: paging.page + 1, size: paging.pageSize }),
    [status, eligible, paging],
  );
  const { data, isLoading, isFetching, error } = usePharmacies(filters);
  const activate = useActivatePharmacy();

  const resetPage = () => setPaging((p) => ({ ...p, page: 0 }));

  const columns: GridColDef<PharmacyOperations>[] = [
    {
      // Work 80: the storefront name, so an operator knows which pharmacy they are activating.
      field: 'displayName',
      headerName: 'Pharmacy',
      flex: 1.4,
      minWidth: 180,
      renderCell: ({ row }) => (
        <Tooltip title={`Pharmacy id ${row.pharmacyId}`}>
          <Typography variant="body2" noWrap>
            {row.displayName}
          </Typography>
        </Tooltip>
      ),
    },
    {
      field: 'transactingStatus',
      headerName: 'Status',
      width: 120,
      renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} />,
    },
    {
      field: 'licenseStatus',
      headerName: 'Licence',
      width: 110,
      renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} />,
    },
    {
      field: 'licenseExpiresAt',
      headerName: 'Licence expiry',
      width: 130,
      valueFormatter: (value: string | null) => (value ? formatDate(value) : '—'),
    },
    {
      field: 'eligible',
      headerName: 'Can transact',
      width: 120,
      valueFormatter: (value: boolean) => (value ? 'Yes' : 'No'),
    },
    {
      field: 'branches',
      headerName: 'Branches (active/total)',
      width: 170,
      sortable: false,
      valueGetter: (_v, row) => `${row.branches.active}/${row.branches.total}`,
    },
    {
      field: 'listings',
      headerName: 'Purchasable listings',
      width: 160,
      sortable: false,
      valueGetter: (_v, row) => `${row.listings.customerPurchasable}/${row.listings.total}`,
    },
    {
      field: 'createdAt',
      headerName: 'Registered',
      width: 120,
      valueFormatter: (value: string) => formatDate(value),
    },
    {
      field: 'actions',
      headerName: '',
      width: 130,
      sortable: false,
      filterable: false,
      renderCell: ({ row }) =>
        canActivate && row.transactingStatus !== 'ACTIVE' ? (
          <Button
            size="small"
            color="success"
            startIcon={<CheckCircleRoundedIcon />}
            disabled={activate.isPending}
            onClick={() => activate.mutate(row.pharmacyId)}
          >
            Activate
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Pharmacies"
        subtitle="Live pharmacies, their licence state and whether they can transact."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as TransactingStatus | 'all');
            resetPage();
          }}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="all">All statuses</MenuItem>
          <MenuItem value="ACTIVE">Active</MenuItem>
          <MenuItem value="PENDING">Pending</MenuItem>
          <MenuItem value="SUSPENDED">Suspended</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          label="Can transact"
          value={eligible}
          onChange={(e) => {
            setEligible(e.target.value as Flag);
            resetPage();
          }}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="any">Any</MenuItem>
          <MenuItem value="yes">Yes</MenuItem>
          <MenuItem value="no">No</MenuItem>
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
        getRowId={(row) => (row as PharmacyOperations).pharmacyId}
        loading={isLoading || isFetching}
        emptyTitle="No pharmacies found"
        emptyDescription="Pharmacies matching your filters will appear here."
        server={{
          rowCount: data?.total ?? 0,
          paginationModel: paging,
          onPaginationModelChange: setPaging,
          pageSizeOptions: [...PHARMACY_PAGE_SIZES],
        }}
      />
    </>
  );
}
