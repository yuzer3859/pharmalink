import { useMemo, useState } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import AddBusinessRoundedIcon from '@mui/icons-material/AddBusinessRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { adminProvidersService, PROVIDER_TYPES, providerTypeLabel, type ProviderListItem, type ProviderStatus, type ProviderType } from '@/services/adminProviders.service';
import { ApiError } from '@/services/apiClient';
import { formatDate } from '@/utils/format';
import { ProviderRecord } from './ProviderRecord';
import { RegisterProviderDialog } from './RegisterProviderDialog';

const PAGE_SIZES = [10, 25, 50];

/**
 * Work 163: every hospital, clinic, diagnostic centre and lab (Module 09), found by name, type
 * and status. Each opens its record — licence and files, administrator and staff, locations,
 * departments, services — with Disable / Enable; and Register provider.
 */
export function ProvidersPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [type, setType] = useState<ProviderType | 'all'>('all');
  const [status, setStatus] = useState<ProviderStatus | 'all'>('all');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const filters = useMemo(() => ({ q: q.trim() || undefined, type, status, page: paging.page + 1, size: paging.pageSize }), [q, type, status, paging]);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['providers', 'list', filters],
    queryFn: () => adminProvidersService.list(filters),
    placeholderData: keepPreviousData,
  });

  const columns: GridColDef<ProviderListItem>[] = [
    { field: 'displayName', headerName: 'Name', flex: 1.4, minWidth: 220 },
    { field: 'type', headerName: 'Type', width: 160, valueFormatter: (v: string) => providerTypeLabel(v) },
    { field: 'city', headerName: 'City', width: 140, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'status', headerName: 'Status', width: 130, renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} /> },
    { field: 'licenseExpiresAt', headerName: 'Licence until', width: 140, valueFormatter: (v: string | null) => (v ? formatDate(v) : '—') },
    { field: 'createdAt', headerName: 'Registered', width: 130, valueFormatter: (v: string) => formatDate(v) },
  ];
  const resetPage = () => setPaging((p) => ({ ...p, page: 0 }));

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Healthcare providers"
        subtitle="Hospitals, clinics, diagnostic centres and labs. Open one for its licence, people, locations and services; disable or enable it there."
        actions={
          can('providers:manage') ? (
            <Button variant="contained" startIcon={<AddBusinessRoundedIcon />} onClick={() => setRegistering(true)}>
              Register provider
            </Button>
          ) : undefined
        }
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="Name"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            resetPage();
          }}
          inputProps={{ maxLength: 100 }}
          sx={{ minWidth: 260 }}
        />
        <TextField
          select
          size="small"
          label="Type"
          value={type}
          onChange={(e) => {
            setType(e.target.value as ProviderType | 'all');
            resetPage();
          }}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="all">All types</MenuItem>
          {PROVIDER_TYPES.map((t) => (
            <MenuItem key={t.value} value={t.value}>
              {t.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as ProviderStatus | 'all');
            resetPage();
          }}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="all">All</MenuItem>
          <MenuItem value="ACTIVE">Active</MenuItem>
          <MenuItem value="PENDING">Pending</MenuItem>
          <MenuItem value="SUSPENDED">Disabled</MenuItem>
        </TextField>
      </Stack>

      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error instanceof ApiError ? error.message : 'Providers could not be loaded.'}
        </Alert>
      ) : null}

      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as ProviderListItem).providerId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as ProviderListItem).providerId)}
        emptyTitle="No providers found"
        emptyDescription="Registered hospitals, clinics, diagnostic centres and labs appear here."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: PAGE_SIZES }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        A disabled provider disappears from customer search at once. A provider whose licence expires is disabled automatically.
      </Typography>

      <ProviderRecord key={selected ?? 'none'} providerId={selected} onClose={() => setSelected(null)} />
      {registering ? (
        <RegisterProviderDialog
          onClose={() => setRegistering(false)}
          onRegistered={(providerId) => {
            setRegistering(false);
            setSelected(providerId);
          }}
        />
      ) : null}
    </>
  );
}
