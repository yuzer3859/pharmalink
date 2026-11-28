import { useState } from 'react';
import { Alert, Button, Card, CardContent, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, MenuItem, Skeleton, Stack, Switch, TextField, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useNotify } from '@/context/NotificationContext';
import { usePortal } from '@/hooks/usePortal';
import { ApiError } from '@/services/apiClient';
import {
  doctorPortalService,
  emptyRule,
  ruleLabel,
  ruleProblem,
  SLOT_TYPE_LABELS,
  WEEKDAYS,
  type AvailabilityRule,
  type PracticeLocation,
  type RuleForm,
  type RuleType,
  type SlotType,
} from '@/services/doctorPortal.service';

const message = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);
const KINDS: Array<{ value: RuleType; label: string }> = [
  { value: 'RECURRING', label: 'Every week' },
  { value: 'EXCEPTION_AVAILABLE', label: 'Extra time on one day' },
  { value: 'EXCEPTION_BLOCK', label: 'Time off' },
];

function RuleDialog({ locations, acceptsTelemedicine, onClose }: { locations: PracticeLocation[]; acceptsTelemedicine: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const [f, setF] = useState<RuleForm>(() => ({ ...emptyRule(), providerLocationId: locations[0]?.locationId ?? '' }));
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setF((x) => ({ ...x, [key]: value }));
  const add = useMutation({
    mutationFn: () => doctorPortalService.addRule(f),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['doctor'] });
      notify(r.slotsCreated > 0 ? `Saved. ${r.slotsCreated} bookable times added for the next 60 days.` : r.slotsRemoved > 0 ? `Saved. ${r.slotsRemoved} times taken off.` : 'Saved.');
      onClose();
    },
    onError: (e) => notify(message(e, 'The availability could not be saved.'), 'error'),
  });
  const problem = ruleProblem(f, acceptsTelemedicine);
  const block = f.type === 'EXCEPTION_BLOCK';
  return (
    <Dialog open onClose={add.isPending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Add availability</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <TextField select size="small" label="Kind" value={f.type} onChange={(e) => set('type', e.target.value as RuleType)}>
            {KINDS.map((k) => (
              <MenuItem key={k.value} value={k.value}>
                {k.label}
              </MenuItem>
            ))}
          </TextField>
          {f.type === 'RECURRING' ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField select size="small" fullWidth label="Day" value={f.weekday} onChange={(e) => set('weekday', Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => (
                  <MenuItem key={d} value={i}>
                    {d}
                  </MenuItem>
                ))}
              </TextField>
              <TextField size="small" fullWidth type="date" label="From (optional)" value={f.fromDate} onChange={(e) => set('fromDate', e.target.value)} InputLabelProps={{ shrink: true }} />
              <TextField size="small" fullWidth type="date" label="Until (optional)" value={f.toDate} onChange={(e) => set('toDate', e.target.value)} InputLabelProps={{ shrink: true }} />
            </Stack>
          ) : (
            <TextField size="small" type="date" label="Day" value={f.fromDate} onChange={(e) => set('fromDate', e.target.value)} InputLabelProps={{ shrink: true }} />
          )}
          {block ? <FormControlLabel control={<Switch checked={f.wholeDay} onChange={(e) => set('wholeDay', e.target.checked)} />} label="The whole day" /> : null}
          {!(block && f.wholeDay) ? (
            <Stack direction="row" spacing={1.5}>
              <TextField size="small" fullWidth type="time" label="From" value={f.startTime} onChange={(e) => set('startTime', e.target.value)} InputLabelProps={{ shrink: true }} />
              <TextField size="small" fullWidth type="time" label="Until" value={f.endTime} onChange={(e) => set('endTime', e.target.value)} InputLabelProps={{ shrink: true }} />
            </Stack>
          ) : null}
          {!block ? (
            <>
              <Stack direction="row" spacing={1.5}>
                <TextField size="small" fullWidth label="Each appointment (minutes)" value={f.slotDurationMinutes} onChange={(e) => set('slotDurationMinutes', e.target.value)} inputProps={{ inputMode: 'numeric' }} />
                <TextField size="small" fullWidth label="Break between (minutes)" value={f.bufferMinutes} onChange={(e) => set('bufferMinutes', e.target.value)} inputProps={{ inputMode: 'numeric' }} />
              </Stack>
              <TextField select size="small" label="How" value={f.appointmentType} onChange={(e) => set('appointmentType', e.target.value as SlotType)}>
                {(Object.keys(SLOT_TYPE_LABELS) as SlotType[]).map((t) => (
                  <MenuItem key={t} value={t} disabled={t !== 'IN_PERSON' && !acceptsTelemedicine}>
                    {SLOT_TYPE_LABELS[t]}
                  </MenuItem>
                ))}
              </TextField>
              <TextField select size="small" label="Where" value={f.providerLocationId} onChange={(e) => set('providerLocationId', e.target.value)}>
                {f.appointmentType !== 'IN_PERSON' ? <MenuItem value="">Video only, no location</MenuItem> : null}
                {locations.map((l) => (
                  <MenuItem key={l.locationId} value={l.locationId}>
                    {l.name} · {l.providerName}
                  </MenuItem>
                ))}
              </TextField>
              {locations.length === 0 ? <Alert severity="info">To see patients in person, a hospital or clinic first adds you as one of its doctors.</Alert> : null}
            </>
          ) : null}
          {problem ? <Alert severity="warning">{problem}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={add.isPending}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!!problem || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Work 170: when the doctor sees patients (Work 167) — weekly patterns, extra time on a day, and
 * time off — in Addis Ababa time. Each change makes or removes bookable times for 60 days;
 * booked times are never removed.
 */
export function DoctorAvailabilityPage() {
  const portal = usePortal();
  const qc = useQueryClient();
  const notify = useNotify();
  const profile = useQuery({ queryKey: ['doctor', 'profile'], queryFn: () => doctorPortalService.profile() });
  const locations = useQuery({ queryKey: ['doctor', 'locations', profile.data?.affiliations.map((a) => a.providerId).join(',')], enabled: !!profile.data, queryFn: () => doctorPortalService.locations(profile.data!) });
  const rules = useQuery({ queryKey: ['doctor', 'rules'], queryFn: () => doctorPortalService.rules() });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AvailabilityRule | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => doctorPortalService.removeRule(id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['doctor'] });
      notify(r.slotsRemoved > 0 ? `Removed. ${r.slotsRemoved} free times taken off; booked ones stay.` : 'Removed.');
    },
    onError: (e) => notify(message(e, 'The availability could not be removed.'), 'error'),
  });
  const loc = locations.data ?? [];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Availability"
        subtitle="When you see patients, in Addis Ababa time. Bookable times are made for the next 60 days."
        actions={
          <Button variant="contained" startIcon={<AddRoundedIcon />} disabled={!profile.data} onClick={() => setAdding(true)}>
            Add availability
          </Button>
        }
      />
      {rules.isLoading ? <Skeleton variant="rounded" height={160} /> : null}
      {rules.error ? <Alert severity="error">{message(rules.error, 'Your availability could not be loaded.')}</Alert> : null}
      {rules.data && rules.data.length === 0 ? <Alert severity="info">No availability yet. Add the days and hours you see patients.</Alert> : null}
      <Stack spacing={1.5}>
        {rules.data?.map((r) => (
          <Card key={r.ruleId} variant="outlined">
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, py: '12px !important' }}>
              <Typography variant="body2" sx={{ flex: 1 }}>
                {ruleLabel(r, loc)}
              </Typography>
              <IconButton aria-label="Remove" onClick={() => setRemoving(r)}>
                <DeleteOutlineRoundedIcon fontSize="small" />
              </IconButton>
            </CardContent>
          </Card>
        ))}
      </Stack>
      {adding && profile.data ? <RuleDialog locations={loc} acceptsTelemedicine={profile.data.acceptsTelemedicine} onClose={() => setAdding(false)} /> : null}
      <ConfirmDialog
        open={!!removing}
        title="Remove this availability?"
        message="Free times it made are taken off. Appointments already booked stay."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removing) remove.mutate(removing.ruleId);
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}
