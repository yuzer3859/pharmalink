import { useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Skeleton, Stack, TextField, Typography } from '@mui/material';
import PersonAddAlt1RoundedIcon from '@mui/icons-material/PersonAddAlt1Rounded';
import type { GridColDef } from '@mui/x-data-grid';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { usePortal } from '@/hooks/usePortal';
import { facilityDoctorsService, type FacilityDoctor } from '@/services/adminDoctors.service';
import { formatDate } from '@/utils/format';
import { facilityErrorMessage, useFacilityProfile } from './useFacility';

const DOCTORS_KEY = ['facility', 'doctors'] as const;

function AddDoctorDialog({ departments, onClose }: { departments: Array<{ departmentId: string; name: string; isActive: boolean }>; onClose: () => void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const [identifier, setIdentifier] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const add = useMutation({
    mutationFn: () => facilityDoctorsService.add({ identifier, departmentId: departmentId || undefined, roleTitle }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCTORS_KEY });
      notify('Doctor added. Patients now see them at your facility.');
      onClose();
    },
    onError: (error) => notify(facilityErrorMessage(error, 'The doctor could not be added.'), 'error'),
  });
  return (
    <Dialog open onClose={add.isPending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Add a doctor</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            The doctor must already be registered by PharmaLink. Use the e-mail or phone they sign in with.
          </Typography>
          <TextField size="small" label="Doctor's e-mail or phone" value={identifier} onChange={(e) => setIdentifier(e.target.value)} inputProps={{ maxLength: 254 }} autoFocus />
          <TextField select size="small" label="Department (optional)" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <MenuItem value="">No department</MenuItem>
            {departments
              .filter((d) => d.isActive)
              .map((d) => (
                <MenuItem key={d.departmentId} value={d.departmentId}>
                  {d.name}
                </MenuItem>
              ))}
          </TextField>
          <TextField size="small" label="Role (e.g. Consultant)" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} inputProps={{ maxLength: 120 }} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={add.isPending}>
          Cancel
        </Button>
        <Button variant="contained" disabled={identifier.trim().length < 3 || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? 'Adding…' : 'Add doctor'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Work 169: the doctors who practise at the facility (Work 166) — added by their sign-in e-mail
 * or phone, optionally in a department — and removed when they no longer do.
 */
export function FacilityDoctorsPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const qc = useQueryClient();
  const notify = useNotify();
  const profile = useFacilityProfile();
  const doctors = useQuery({ queryKey: DOCTORS_KEY, queryFn: () => facilityDoctorsService.list() });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<FacilityDoctor | null>(null);
  const remove = useMutation({
    mutationFn: (doctorId: string) => facilityDoctorsService.remove(doctorId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCTORS_KEY });
      notify('Doctor removed from your facility.');
    },
    onError: (error) => notify(facilityErrorMessage(error, 'The doctor could not be removed.'), 'error'),
  });
  const writable = can('facility:manage') && profile.data?.status !== 'SUSPENDED';

  const columns: GridColDef<FacilityDoctor>[] = [
    { field: 'fullName', headerName: 'Doctor', flex: 1.2, minWidth: 200 },
    { field: 'specialty', headerName: 'Specialty', flex: 1, minWidth: 150, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'departmentName', headerName: 'Department', width: 160, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'roleTitle', headerName: 'Role', width: 140, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'listed', headerName: 'Bookable', width: 120, renderCell: ({ value }) => <StatusChip status={value ? 'active' : 'suspended'} /> },
    { field: 'since', headerName: 'Since', width: 120, valueFormatter: (v: string) => formatDate(v) },
    {
      field: 'actions',
      headerName: '',
      width: 110,
      sortable: false,
      renderCell: ({ row }) =>
        writable ? (
          <Button size="small" color="error" onClick={() => setRemoving(row)}>
            Remove
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Doctors"
        subtitle="The doctors who practise at your facility. Patients find and book them here."
        actions={
          writable ? (
            <Button variant="contained" startIcon={<PersonAddAlt1RoundedIcon />} onClick={() => setAdding(true)}>
              Add doctor
            </Button>
          ) : undefined
        }
      />
      {doctors.isLoading ? <Skeleton variant="rounded" height={200} /> : null}
      {doctors.error ? <Alert severity="error">{facilityErrorMessage(doctors.error, 'Your doctors could not be loaded.')}</Alert> : null}
      {doctors.data ? (
        <DataTable
          rows={doctors.data}
          columns={columns as GridColDef[]}
          getRowId={(row) => (row as FacilityDoctor).doctorId}
          emptyTitle="No doctors yet"
          emptyDescription="Add the doctors who see patients here. PharmaLink registers doctors first."
        />
      ) : null}
      {adding && profile.data ? <AddDoctorDialog departments={profile.data.departments} onClose={() => setAdding(false)} /> : null}
      <ConfirmDialog
        open={!!removing}
        title="Remove this doctor?"
        message={`${removing?.fullName ?? ''} stops appearing at your facility. Their existing appointments stay.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removing) remove.mutate(removing.doctorId);
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}
