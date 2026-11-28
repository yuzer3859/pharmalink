import { useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Skeleton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { useNotify } from '@/context/NotificationContext';
import { usePortal } from '@/hooks/usePortal';
import { ApiError } from '@/services/apiClient';
import { addDays, doctorPortalService, localDay, localTime, localToday, SLOT_TYPE_LABELS, type DoctorSlot } from '@/services/doctorPortal.service';

const COLORS: Record<DoctorSlot['status'], 'success' | 'primary' | 'default' | 'warning'> = { OPEN: 'success', BOOKED: 'primary', BLOCKED: 'default', HELD: 'warning' };
const STATUS_WORDS: Record<DoctorSlot['status'], string> = { OPEN: 'Free', BOOKED: 'Booked', BLOCKED: 'Blocked', HELD: 'Being booked' };

/**
 * Work 170: the doctor's week of bookable times (Work 167), generated from their availability.
 * A free future time can be blocked (taken off), and a blocked one opened again. Booked times
 * are changed from Appointments.
 */
export function DoctorSchedulePage() {
  const portal = usePortal();
  const qc = useQueryClient();
  const notify = useNotify();
  const [from, setFrom] = useState(localToday());
  const to = addDays(from, 6);
  const { data, isLoading, error } = useQuery({ queryKey: ['doctor', 'slots', from], queryFn: () => doctorPortalService.slots(from, to) });
  const toggle = useMutation({
    mutationFn: (s: DoctorSlot) => doctorPortalService.setBlocked(s.slotId, s.status === 'OPEN'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['doctor', 'slots'] });
      notify(r.status === 'BLOCKED' ? 'Time blocked. Patients no longer see it.' : 'Time open again.');
    },
    onError: (e) => notify(e instanceof ApiError ? e.message : 'The time could not be changed.', 'error'),
  });

  const days = useMemo(() => {
    const groups = new Map<string, DoctorSlot[]>();
    for (const s of data ?? []) groups.set(localDay(s.startAt), [...(groups.get(localDay(s.startAt)) ?? []), s]);
    return [...groups.entries()];
  }, [data]);
  const counts = useMemo(() => (data ?? []).reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {}), [data]);

  return (
    <>
      <PageHeader portalName={portal.title} title="Schedule" subtitle="Your bookable times for the week, made from your availability. Click a free time to block it, or a blocked one to open it." />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
        <Button size="small" onClick={() => setFrom(addDays(from, -7))}>
          Previous week
        </Button>
        <TextField size="small" type="date" label="Week from" value={from} onChange={(e) => setFrom(e.target.value || localToday())} InputLabelProps={{ shrink: true }} />
        <Button size="small" onClick={() => setFrom(addDays(from, 7))}>
          Next week
        </Button>
        <Typography variant="body2" color="text.secondary">
          {counts.OPEN ?? 0} free · {counts.BOOKED ?? 0} booked · {counts.BLOCKED ?? 0} blocked
        </Typography>
      </Stack>
      {isLoading ? <Skeleton variant="rounded" height={240} /> : null}
      {error ? <Alert severity="error">{error instanceof ApiError ? error.message : 'Your schedule could not be loaded.'}</Alert> : null}
      {data && data.length === 0 ? <Alert severity="info">No times this week. Add your availability to create bookable times.</Alert> : null}
      <Stack spacing={2}>
        {days.map(([day, slots]) => (
          <Box key={day}>
            <Typography variant="subtitle2" gutterBottom>
              {day}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              {slots.map((s) => {
                const future = Date.parse(s.startAt) > Date.now();
                const clickable = future && (s.status === 'OPEN' || s.status === 'BLOCKED');
                return (
                  <Tooltip key={s.slotId} title={`${STATUS_WORDS[s.status]} · ${SLOT_TYPE_LABELS[s.appointmentType]}`}>
                    <Chip
                      label={localTime(s.startAt)}
                      color={COLORS[s.status]}
                      variant={s.status === 'OPEN' ? 'outlined' : 'filled'}
                      onClick={clickable && !toggle.isPending ? () => toggle.mutate(s) : undefined}
                      sx={{ textDecoration: s.status === 'BLOCKED' ? 'line-through' : 'none' }}
                    />
                  </Tooltip>
                );
              })}
            </Stack>
          </Box>
        ))}
      </Stack>
    </>
  );
}
