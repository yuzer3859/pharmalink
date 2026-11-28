import { useMemo, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Skeleton, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { StatusChip } from '@/components/common/StatusChip';
import { useNotify } from '@/context/NotificationContext';
import { usePortal } from '@/hooks/usePortal';
import { feeLabel, type StaffAppointment } from '@/services/adminDoctors.service';
import { ApiError } from '@/services/apiClient';
import { addDays, APPOINTMENT_TYPE_LABELS, doctorPortalService, localDay, localTime, localToday } from '@/services/doctorPortal.service';
import { isValidSuspendReason } from '@/services/pharmacies.service';

const message = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);
const KEY = ['doctor', 'appointments'] as const;

/**
 * Work 170: the doctor's appointments (Work 168), day by day — who, when, where, why — with
 * Check in (from an hour before), Complete, No-show (after the start) and Cancel with a reason
 * (before the start; the time is then not offered again). The fee is paid at the visit.
 */
export function DoctorAppointmentsPage() {
  const portal = usePortal();
  const qc = useQueryClient();
  const notify = useNotify();
  const [from, setFrom] = useState(localToday());
  const [days, setDays] = useState(7);
  const to = useMemo(() => addDays(from, days - 1), [from, days]);
  const [cancelling, setCancelling] = useState<StaffAppointment | null>(null);
  const [reason, setReason] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: [...KEY, from, to], queryFn: () => doctorPortalService.appointments(from, to) });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'check-in' | 'complete' | 'no-show' | 'cancel' }) => doctorPortalService.act(id, action, reason),
    onSuccess: (_r, { action }) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['doctor', 'slots'] });
      notify({ 'check-in': 'Checked in.', complete: 'Appointment completed.', 'no-show': 'Marked as a no-show.', cancel: 'Appointment cancelled. The patient is told.' }[action]);
      setCancelling(null);
      setReason('');
    },
    onError: (e) => notify(message(e, 'The change could not be made.'), 'error'),
  });

  const byDay = useMemo(() => {
    const groups = new Map<string, StaffAppointment[]>();
    for (const a of data ?? []) {
      const day = localDay(a.startsAt);
      groups.set(day, [...(groups.get(day) ?? []), a]);
    }
    return [...groups.entries()];
  }, [data]);

  return (
    <>
      <PageHeader portalName={portal.title} title="Appointments" subtitle="Your patients, day by day. Times are Addis Ababa time; patients pay the fee at the visit." />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField size="small" type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value || localToday())} InputLabelProps={{ shrink: true }} />
        <TextField select size="small" label="Show" value={days} onChange={(e) => setDays(Number(e.target.value))} sx={{ minWidth: 140 }}>
          <MenuItem value={1}>One day</MenuItem>
          <MenuItem value={7}>A week</MenuItem>
          <MenuItem value={31}>A month</MenuItem>
        </TextField>
      </Stack>
      {isLoading ? <Skeleton variant="rounded" height={200} /> : null}
      {error ? <Alert severity="error">{message(error, 'Your appointments could not be loaded.')}</Alert> : null}
      {data && data.length === 0 ? <Alert severity="info">No appointments in these dates.</Alert> : null}
      <Stack spacing={2.5}>
        {byDay.map(([day, items]) => (
          <Box key={day}>
            <Typography variant="subtitle2" gutterBottom>
              {day}
            </Typography>
            <Stack spacing={1.5}>
              {items.map((a) => {
                const started = Date.parse(a.startsAt) <= Date.now();
                const checkInOpen = Date.parse(a.startsAt) - Date.now() <= 60 * 60_000;
                return (
                  <Card key={a.appointmentId} variant="outlined">
                    <CardContent sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2, alignItems: { md: 'center' } }}>
                      <Box sx={{ minWidth: 110 }}>
                        <Typography variant="h6">{localTime(a.startsAt)}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          until {localTime(a.endsAt)}
                        </Typography>
                      </Box>
                      <Box sx={{ flex: 1 }}>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                          <StatusChip status={a.status.toLowerCase()} />
                          <Chip size="small" label={APPOINTMENT_TYPE_LABELS[a.appointmentType] ?? a.appointmentType} />
                        </Stack>
                        <Typography variant="body2">Patient: {a.patient.phone ?? a.patient.email ?? '—'}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {a.location ? `${a.location.name}${a.location.city ? `, ${a.location.city}` : ''}` : 'Video'} · {feeLabel(a.fee, a.currency)} at the visit
                        </Typography>
                        {a.reasonNote ? (
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            Reason: {a.reasonNote}
                          </Typography>
                        ) : null}
                        {a.cancelReason ? (
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            Cancelled: {a.cancelReason}
                          </Typography>
                        ) : null}
                      </Box>
                      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                        {a.status === 'CONFIRMED' && checkInOpen ? (
                          <Button size="small" variant="outlined" disabled={act.isPending} onClick={() => act.mutate({ id: a.appointmentId, action: 'check-in' })}>
                            Check in
                          </Button>
                        ) : null}
                        {['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'].includes(a.status) && checkInOpen ? (
                          <Button size="small" variant="contained" disabled={act.isPending} onClick={() => act.mutate({ id: a.appointmentId, action: 'complete' })}>
                            Complete
                          </Button>
                        ) : null}
                        {['CONFIRMED', 'CHECKED_IN'].includes(a.status) && started ? (
                          <Button size="small" color="warning" disabled={act.isPending} onClick={() => act.mutate({ id: a.appointmentId, action: 'no-show' })}>
                            No-show
                          </Button>
                        ) : null}
                        {a.status === 'CONFIRMED' && !started ? (
                          <Button size="small" color="error" onClick={() => setCancelling(a)}>
                            Cancel
                          </Button>
                        ) : null}
                      </Stack>
                    </CardContent>
                  </Card>
                );
              })}
            </Stack>
          </Box>
        ))}
      </Stack>
      <Dialog open={!!cancelling} onClose={() => setCancelling(null)} fullWidth maxWidth="sm">
        <DialogTitle>Cancel this appointment?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The patient is told and asked to book another time. This time is not offered to anyone else.
          </Typography>
          <TextField autoFocus fullWidth multiline minRows={2} label="Reason (the patient does not see it)" value={reason} onChange={(e) => setReason(e.target.value)} inputProps={{ maxLength: 500 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelling(null)}>Keep it</Button>
          <Button color="error" variant="contained" disabled={!isValidSuspendReason(reason) || act.isPending} onClick={() => cancelling && act.mutate({ id: cancelling.appointmentId, action: 'cancel' })}>
            Cancel appointment
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
