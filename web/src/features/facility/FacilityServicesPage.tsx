import { useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Skeleton, Stack, Switch, TextField } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { SERVICE_TYPE_LABELS } from '@/services/adminProviders.service';
import { facilityPortalService, offersServices, serviceProblem, type FacilityLocation, type FacilityService, type ServiceForm } from '@/services/facilityPortal.service';
import { currency } from '@/utils/format';
import { facilityErrorMessage, useFacilityChange, useFacilityProfile } from './useFacility';

const EMPTY: ServiceForm = { type: 'LAB_TEST', name: '', code: '', price: '', durationMinutes: '', preparationInstructions: '', locationId: '', isAvailable: true };

function formFrom(s: FacilityService): ServiceForm {
  return {
    type: s.type as ServiceForm['type'],
    name: s.name,
    code: s.code ?? '',
    price: s.price === null ? '' : String(s.price / 100),
    durationMinutes: s.durationMinutes === null ? '' : String(s.durationMinutes),
    preparationInstructions: s.preparationInstructions ?? '',
    locationId: s.locationId ?? '',
    isAvailable: s.isAvailable,
  };
}

function ServiceDialog({ initial, serviceId, locations, onClose }: { initial: ServiceForm; serviceId: string | null; locations: FacilityLocation[]; onClose: () => void }) {
  const [form, setForm] = useState<ServiceForm>(initial);
  const save = useFacilityChange(
    (f: ServiceForm) => (serviceId ? facilityPortalService.updateService(serviceId, f) : facilityPortalService.addService(f)),
    serviceId ? 'Service saved.' : 'Service added. Customers can compare it in search shortly.',
  );
  const problem = serviceProblem(form);
  const set = (key: keyof ServiceForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <Dialog open onClose={save.isPending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{serviceId ? 'Edit service' : 'Add a service'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField select size="small" fullWidth label="Kind" value={form.type} onChange={set('type')}>
              {Object.entries(SERVICE_TYPE_LABELS).map(([value, label]) => (
                <MenuItem key={value} value={value}>
                  {label}
                </MenuItem>
              ))}
            </TextField>
            <TextField size="small" fullWidth label="Code (e.g. CBC)" value={form.code} onChange={set('code')} inputProps={{ maxLength: 40 }} />
          </Stack>
          <TextField size="small" label="Name (e.g. Complete blood count)" value={form.name} onChange={set('name')} inputProps={{ maxLength: 160 }} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField size="small" fullWidth label="Price in birr (blank: on request)" value={form.price} onChange={set('price')} inputProps={{ inputMode: 'decimal' }} />
            <TextField size="small" fullWidth label="Takes (minutes)" value={form.durationMinutes} onChange={set('durationMinutes')} inputProps={{ inputMode: 'numeric' }} />
          </Stack>
          <TextField size="small" label="How to prepare (e.g. fast for 8 hours)" value={form.preparationInstructions} onChange={set('preparationInstructions')} multiline minRows={2} inputProps={{ maxLength: 2000 }} />
          <TextField select size="small" label="Offered at" value={form.locationId} onChange={set('locationId')}>
            <MenuItem value="">Every location</MenuItem>
            {locations.map((l) => (
              <MenuItem key={l.locationId} value={l.locationId}>
                {l.name}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel control={<Switch checked={form.isAvailable} onChange={(e) => setForm((f) => ({ ...f, isAvailable: e.target.checked }))} />} label="Available now (shown to customers)" />
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
 * Work 164: a lab's or diagnostic centre's tests, imaging and screening packages — with price,
 * preparation and where each is offered — that customers compare in search (Work 162).
 */
export function FacilityServicesPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const profile = useFacilityProfile();
  const [editing, setEditing] = useState<{ form: ServiceForm; serviceId: string | null } | null>(null);
  const [removing, setRemoving] = useState<FacilityService | null>(null);
  const remove = useFacilityChange((id: string) => facilityPortalService.removeService(id), 'Service removed.');
  const p = profile.data;
  const allowed = offersServices(p?.type);
  const writable = can('facility:manage') && p?.status !== 'SUSPENDED' && allowed;
  const locationName = (id: string | null) => (id ? (p?.locations.find((l) => l.locationId === id)?.name ?? '—') : 'Every location');

  const columns: GridColDef<FacilityService>[] = [
    { field: 'name', headerName: 'Service', flex: 1.2, minWidth: 200 },
    { field: 'type', headerName: 'Kind', width: 150, valueFormatter: (v: string) => SERVICE_TYPE_LABELS[v] ?? v },
    { field: 'price', headerName: 'Price', width: 130, valueFormatter: (v: number | null) => (v === null ? 'On request' : currency(v / 100)) },
    { field: 'locationId', headerName: 'Offered at', width: 160, valueFormatter: (v: string | null) => locationName(v) },
    { field: 'isAvailable', headerName: 'Status', width: 130, renderCell: ({ value }) => <StatusChip status={value ? 'available' : 'unavailable'} /> },
    {
      field: 'actions',
      headerName: '',
      width: 170,
      sortable: false,
      renderCell: ({ row }) =>
        writable ? (
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={() => setEditing({ form: formFrom(row), serviceId: row.serviceId })}>
              Edit
            </Button>
            <Button size="small" color="error" onClick={() => setRemoving(row)}>
              Remove
            </Button>
          </Stack>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Services"
        subtitle="Tests, imaging and screening packages customers can compare by price and distance."
        actions={
          writable ? (
            <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setEditing({ form: EMPTY, serviceId: null })}>
              Add service
            </Button>
          ) : undefined
        }
      />
      {profile.isLoading ? <Skeleton variant="rounded" height={200} /> : null}
      {profile.error ? <Alert severity="error">{facilityErrorMessage(profile.error, 'Your facility could not be loaded.')}</Alert> : null}
      {p && !allowed ? (
        <Alert severity="info">Only laboratories and diagnostic centres list tests and imaging. Hospitals and clinics list their departments instead.</Alert>
      ) : null}
      {p && allowed ? (
        <DataTable
          rows={p.services}
          columns={columns as GridColDef[]}
          getRowId={(row) => (row as FacilityService).serviceId}
          emptyTitle="No services yet"
          emptyDescription="Add tests such as a complete blood count, or imaging such as a chest X-ray."
        />
      ) : null}
      {editing && p ? <ServiceDialog initial={editing.form} serviceId={editing.serviceId} locations={p.locations} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!removing}
        title="Remove this service?"
        message={`${removing?.name ?? ''} stops appearing to customers. To hide it for a while, edit it and switch off “Available now” instead.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removing) remove.mutate(removing.serviceId);
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}
