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
import { adminDoctorsService, type DoctorListItem, type DoctorStatus } from '@/services/adminDoctors.service';
import { ApiError } from '@/services/apiClient';
import { formatDate } from '@/utils/format';
import { DoctorRecord } from './DoctorRecord';
import { RegisterDoctorDialog } from './RegisterDoctorDialog';

const PAGE_SIZES = [10, 25, 50];

/**
 * Work 169: every doctor (Module 10), found by name, specialty or licence number, and status.
 * Each opens their record — licence and files, account, profile, where they practise — with
 * Disable / Enable; and Register doctor.
 */
export function DoctorsPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<DoctorStatus | 'all'>('all');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const filters = useMemo(() => ({ q: q.trim() || undefined, status, page: paging.page + 1, size: paging.pageSize }), [q, status, paging]);
  const { data, isLoading, isFetching, error } = useQuery({ queryKey: ['doctors', 'list', filters], queryFn: () => adminDoctorsService.list(filters), placeholderData: keepPreviousData });

  const columns: GridColDef<DoctorListItem>[] = [
    { field: 'fullName', headerName: 'Name', flex: 1.3, minWidth: 220 },
    { field: 'specialty', headerName: 'Specialty', flex: 1, minWidth: 160, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'status', headerName: 'Status', width: 130, renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} /> },
    { field: 'licenseNumber', headerName: 'Licence', width: 170, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'licenseExpiresAt', headerName: 'Licence until', width: 140, valueFormatter: (v: string | null) => (v ? formatDate(v) : '—') },
    { field: 'createdAt', headerName: 'Registered', width: 130, valueFormatter: (v: string) => formatDate(v) },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Doctors"
        subtitle="Every registered doctor. Open one for their licence, account and where they practise; disable or enable them there."
        actions={
          can('doctors:manage') ? (
            <Button variant="contained" startIcon={<PersonAddAlt1RoundedIcon />} onClick={() => setRegistering(true)}>
              Register doctor
            </Button>
          ) : undefined
        }
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="Name, specialty or licence"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPaging((p) => ({ ...p, page: 0 }));
          }}
          inputProps={{ maxLength: 100 }}
          sx={{ minWidth: 280 }}
        />
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as DoctorStatus | 'all');
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
          {error instanceof ApiError ? error.message : 'Doctors could not be loaded.'}
        </Alert>
      ) : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as DoctorListItem).doctorId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as DoctorListItem).doctorId)}
        emptyTitle="No doctors found"
        emptyDescription="Registered doctors appear here."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: PAGE_SIZES }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        A disabled doctor is signed out, hidden from patients and cannot be booked. A doctor whose licence expires is disabled automatically.
      </Typography>
      <DoctorRecord key={selected ?? 'none'} doctorId={selected} onClose={() => setSelected(null)} />
      {registering ? (
        <RegisterDoctorDialog
          onClose={() => setRegistering(false)}
          onRegistered={(doctorId) => {
            setRegistering(false);
            setSelected(doctorId);
          }}
        />
      ) : null}
    </>
  );
}
