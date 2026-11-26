import { useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Skeleton, Stack, TextField } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { departmentProblem, facilityPortalService, type DepartmentForm, type FacilityDepartment } from '@/services/facilityPortal.service';
import { facilityErrorMessage, useFacilityChange, useFacilityProfile } from './useFacility';

const EMPTY: DepartmentForm = { name: '', specialty: '', description: '', contactPhone: '' };

function DepartmentDialog({ initial, departmentId, onClose }: { initial: DepartmentForm; departmentId: string | null; onClose: () => void }) {
  const [form, setForm] = useState<DepartmentForm>(initial);
  const save = useFacilityChange(
    (f: DepartmentForm) => (departmentId ? facilityPortalService.updateDepartment(departmentId, f) : facilityPortalService.addDepartment(f)),
    departmentId ? 'Department saved.' : 'Department added.',
  );
  const problem = departmentProblem(form);
  const set = (key: keyof DepartmentForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <Dialog open onClose={save.isPending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{departmentId ? 'Edit department' : 'Add a department'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <TextField size="small" label="Name (e.g. Cardiology)" value={form.name} onChange={set('name')} inputProps={{ maxLength: 120 }} />
          <TextField size="small" label="Specialty customers search for" value={form.specialty} onChange={set('specialty')} inputProps={{ maxLength: 120 }} />
          <TextField size="small" label="Description" value={form.description} onChange={set('description')} multiline minRows={2} inputProps={{ maxLength: 1000 }} />
          <TextField size="small" label="Direct phone" value={form.contactPhone} onChange={set('contactPhone')} />
          {problem ? <Alert severity="warning">{problem}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!!problem || save.isPending} onClick={() => save.mutate(form, { onSuccess: onClose })}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Work 164: the facility's departments and the specialties customers find it by. A department
 * is closed rather than deleted, because doctors are linked to departments (Module 10).
 */
export function FacilityDepartmentsPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const canManage = can('facility:manage');
  const profile = useFacilityProfile();
  const [editing, setEditing] = useState<{ form: DepartmentForm; departmentId: string | null } | null>(null);
  const [closing, setClosing] = useState<FacilityDepartment | null>(null);
  const close = useFacilityChange((id: string) => facilityPortalService.closeDepartment(id), 'Department closed.');
  const reopen = useFacilityChange((id: string) => facilityPortalService.reopenDepartment(id), 'Department open again.');
  const p = profile.data;
  const writable = canManage && p?.status !== 'SUSPENDED';

  const columns: GridColDef<FacilityDepartment>[] = [
    { field: 'name', headerName: 'Department', flex: 1, minWidth: 180 },
    { field: 'specialty', headerName: 'Specialty', flex: 1, minWidth: 160, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'contactPhone', headerName: 'Phone', width: 170, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'isActive', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value ? 'active' : 'closed'} /> },
    {
      field: 'actions',
      headerName: '',
      width: 190,
      sortable: false,
      renderCell: ({ row }) =>
        writable ? (
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={() => setEditing({ form: { name: row.name, specialty: row.specialty ?? '', description: row.description ?? '', contactPhone: row.contactPhone ?? '' }, departmentId: row.departmentId })}>
              Edit
            </Button>
            {row.isActive ? (
              <Button size="small" color="error" onClick={() => setClosing(row)}>
                Close
              </Button>
            ) : (
              <Button size="small" onClick={() => reopen.mutate(row.departmentId)}>
                Reopen
              </Button>
            )}
          </Stack>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Departments"
        subtitle="Departments and specialties customers can find you by."
        actions={
          writable ? (
            <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setEditing({ form: EMPTY, departmentId: null })}>
              Add department
            </Button>
          ) : undefined
        }
      />
      {profile.isLoading ? <Skeleton variant="rounded" height={200} /> : null}
      {profile.error ? <Alert severity="error">{facilityErrorMessage(profile.error, 'Your facility could not be loaded.')}</Alert> : null}
      {p ? (
        <DataTable
          rows={p.departments}
          columns={columns as GridColDef[]}
          getRowId={(row) => (row as FacilityDepartment).departmentId}
          emptyTitle="No departments yet"
          emptyDescription="Add departments such as Cardiology, Paediatrics or Radiology."
        />
      ) : null}
      {editing ? <DepartmentDialog initial={editing.form} departmentId={editing.departmentId} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!closing}
        title="Close this department?"
        message={`${closing?.name ?? ''} stops appearing to customers. You can reopen it later.`}
        confirmLabel="Close department"
        destructive
        onConfirm={() => {
          if (closing) close.mutate(closing.departmentId);
          setClosing(null);
        }}
        onClose={() => setClosing(null)}
      />
    </>
  );
}
