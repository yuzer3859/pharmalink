import { useMemo, useState } from 'react';
import { Alert, Skeleton, Stack, TextField, Typography } from '@mui/material';
import type { GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { usePortal } from '@/hooks/usePortal';
import { appointmentTimeLabel, facilityDoctorsService, feeLabel, type StaffAppointment } from '@/services/adminDoctors.service';
import { facilityErrorMessage } from './useFacility';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date());
const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Work 169: the appointments booked at the facility's locations (Work 168), for the front desk:
 * who, with which doctor, when, and how to reach the patient. The fee is paid at the visit.
 */
export function FacilityAppointmentsPage() {
  const portal = usePortal();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(plusDays(today(), 7));
  const range = useMemo(() => ({ from, to: to < from ? from : to }), [from, to]);
  const { data, isLoading, error } = useQuery({ queryKey: ['facility', 'appointments', range], queryFn: () => facilityDoctorsService.appointments(range) });

  const columns: GridColDef<StaffAppointment>[] = [
    { field: 'startsAt', headerName: 'When', width: 170, valueFormatter: (v: string) => appointmentTimeLabel(v) },
    { field: 'doctor', headerName: 'Doctor', flex: 1, minWidth: 180, valueGetter: (_v, row) => row.doctor.fullName },
    { field: 'patient', headerName: 'Patient', flex: 1, minWidth: 180, valueGetter: (_v, row) => row.patient.phone ?? row.patient.email ?? '—' },
    { field: 'location', headerName: 'Location', width: 150, valueGetter: (_v, row) => row.location?.name ?? 'Video' },
    { field: 'status', headerName: 'Status', width: 130, renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} /> },
    { field: 'fee', headerName: 'Fee (at visit)', width: 130, valueGetter: (_v, row) => feeLabel(row.fee, row.currency) },
  ];

  return (
    <>
      <PageHeader portalName={portal.title} title="Appointments" subtitle="Appointments booked with your doctors at your locations. Times are Addis Ababa time." />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField size="small" type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
        <TextField size="small" type="date" label="To" value={to} onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
      </Stack>
      {isLoading ? <Skeleton variant="rounded" height={200} /> : null}
      {error ? <Alert severity="error">{facilityErrorMessage(error, 'The appointments could not be loaded.')}</Alert> : null}
      {data ? (
        <DataTable
          rows={data}
          columns={columns as GridColDef[]}
          getRowId={(row) => (row as StaffAppointment).appointmentId}
          emptyTitle="No appointments in these dates"
          emptyDescription="Appointments patients book with your doctors appear here."
        />
      ) : null}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        Patients pay the consultation fee at the visit. A range is at most 31 days.
      </Typography>
    </>
  );
}
