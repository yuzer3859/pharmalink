import { useMemo, useState } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import PersonAddAlt1RoundedIcon from '@mui/icons-material/PersonAddAlt1Rounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { adminDriversService } from '@/services/adminDrivers.service';
import { ApiError } from '@/services/apiClient';
import { formatDate } from '@/utils/format';
import type { AdminAccount } from '@/types';
import { DriverRecord } from './DriverRecord';
import { RegisterDriverDialog } from './RegisterDriverDialog';

const PAGE_SIZES = [10, 25, 50];

/**
 * Work 156: every driver, found by exact e-mail or phone, each opening their record (account,
 * vehicle, documents) with Disable / Enable; and Register driver.
 */
export function DriversPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [status, setStatus] = useState('all');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const search = identifier.trim().length >= 3 ? identifier.trim() : undefined;
  const filters = useMemo(() => ({ identifier: search, status, page: paging.page + 1, size: paging.pageSize }), [search, status, paging]);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['drivers', 'list', filters],
    queryFn: () => adminDriversService.list(filters),
    placeholderData: keepPreviousData,
  });

  const columns: GridColDef<AdminAccount>[] = [
    { field: 'email', headerName: 'E-mail', flex: 1.2, minWidth: 200, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'phone', headerName: 'Phone', width: 160, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'status', headerName: 'Account', width: 140, renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} /> },
    { field: 'createdAt', headerName: 'Signed up', width: 130, valueFormatter: (v: string) => formatDate(v) },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Drivers"
        subtitle="Every delivery driver. Open one for their vehicle, documents and status; disable or enable them there."
        actions={
          can('drivers:manage') ? (
            <Button variant="contained" startIcon={<PersonAddAlt1RoundedIcon />} onClick={() => setRegistering(true)}>
              Register driver
            </Button>
          ) : undefined
        }
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
          {error instanceof ApiError ? error.message : 'Drivers could not be loaded.'}
        </Alert>
      ) : null}

      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as AdminAccount).userId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as AdminAccount).userId)}
        emptyTitle="No drivers found"
        emptyDescription="Registered drivers appear here."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: PAGE_SIZES }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        A disabled driver is signed out, gets no delivery offers and cannot go online.
      </Typography>

      <DriverRecord key={selected ?? 'none'} userId={selected} onClose={() => setSelected(null)} />
      {registering ? (
        <RegisterDriverDialog
          onClose={() => setRegistering(false)}
          onRegistered={(userId) => {
            setRegistering(false);
            setSelected(userId);
          }}
        />
      ) : null}
    </>
  );
}
