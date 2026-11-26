import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import AddLocationAltRoundedIcon from '@mui/icons-material/AddLocationAltRounded';
import MyLocationRoundedIcon from '@mui/icons-material/MyLocationRounded';
import { PageHeader } from '@/components/common/PageHeader';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { EMERGENCY_LABELS, WEEKDAYS } from '@/services/adminProviders.service';
import {
  facilityPortalService,
  hoursProblem,
  locationProblem,
  weekFrom,
  type DayHours,
  type FacilityLocation,
  type LocationForm,
} from '@/services/facilityPortal.service';
import { facilityErrorMessage, useFacilityChange, useFacilityProfile } from './useFacility';

const EMPTY: LocationForm = { name: '', city: 'Addis Ababa', subcity: '', woreda: '', addressLine: '', lat: '', lng: '', phone: '', emergencyAvailability: 'NONE', isPrimary: false };
const SUGGESTED_FACILITIES = ['Parking', 'Ambulance', 'Wheelchair access', 'Pharmacy on site', 'Cafeteria', 'Waiting area', 'Wi-Fi'];

function formFrom(l: FacilityLocation): LocationForm {
  return {
    name: l.name,
    city: l.city ?? '',
    subcity: l.subcity ?? '',
    woreda: l.woreda ?? '',
    addressLine: l.addressLine ?? '',
    lat: l.lat === null ? '' : String(l.lat),
    lng: l.lng === null ? '' : String(l.lng),
    phone: l.phone ?? '',
    emergencyAvailability: (l.emergencyAvailability as LocationForm['emergencyAvailability']) ?? 'NONE',
    isPrimary: l.isPrimary,
  };
}

function LocationDialog({ initial, locationId, onClose }: { initial: LocationForm; locationId: string | null; onClose: () => void }) {
  const [form, setForm] = useState<LocationForm>(initial);
  const [locating, setLocating] = useState(false);
  const [geoProblem, setGeoProblem] = useState<string | null>(null);
  const save = useFacilityChange(
    (f: LocationForm) => (locationId ? facilityPortalService.updateLocation(locationId, f) : facilityPortalService.addLocation(f)),
    locationId ? 'Location saved.' : 'Location added. Customers nearby can find you now.',
  );
  const problem = locationProblem(form);
  const set = (key: keyof LocationForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  function fillMyPosition() {
    if (!navigator.geolocation) {
      setGeoProblem('This browser cannot tell your position; enter it from a map instead.');
      return;
    }
    setLocating(true);
    setGeoProblem(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, lat: pos.coords.latitude.toFixed(5), lng: pos.coords.longitude.toFixed(5) }));
        setLocating(false);
      },
      () => {
        setGeoProblem('Your position is not available; enter it from a map instead.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  return (
    <Dialog open onClose={save.isPending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{locationId ? 'Edit location' : 'Add a location'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <TextField size="small" label="Name (e.g. Main campus)" value={form.name} onChange={set('name')} inputProps={{ maxLength: 120 }} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField size="small" fullWidth label="City" value={form.city} onChange={set('city')} inputProps={{ maxLength: 80 }} />
            <TextField size="small" fullWidth label="Sub-city" value={form.subcity} onChange={set('subcity')} inputProps={{ maxLength: 80 }} />
            <TextField size="small" fullWidth label="Woreda" value={form.woreda} onChange={set('woreda')} inputProps={{ maxLength: 40 }} />
          </Stack>
          <TextField size="small" label="Street, building, landmark" value={form.addressLine} onChange={set('addressLine')} inputProps={{ maxLength: 200 }} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
            <TextField size="small" fullWidth label="Latitude" value={form.lat} onChange={set('lat')} inputProps={{ inputMode: 'decimal' }} />
            <TextField size="small" fullWidth label="Longitude" value={form.lng} onChange={set('lng')} inputProps={{ inputMode: 'decimal' }} />
            <Button variant="outlined" startIcon={<MyLocationRoundedIcon />} onClick={fillMyPosition} disabled={locating} sx={{ whiteSpace: 'nowrap', minWidth: 'auto' }}>
              {locating ? 'Finding…' : 'I am here'}
            </Button>
          </Stack>
          {geoProblem ? <Alert severity="info">{geoProblem}</Alert> : null}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField size="small" fullWidth label="Phone" value={form.phone} onChange={set('phone')} />
            <TextField select size="small" fullWidth label="Emergency" value={form.emergencyAvailability} onChange={set('emergencyAvailability')}>
              {Object.entries(EMERGENCY_LABELS).map(([value, label]) => (
                <MenuItem key={value} value={value}>
                  {label}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <FormControlLabel control={<Switch checked={form.isPrimary} onChange={(e) => setForm((f) => ({ ...f, isPrimary: e.target.checked }))} />} label="Main location (search measures distance to it)" />
          {problem ? <Alert severity="warning">{problem}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!!problem || save.isPending} onClick={() => save.mutate(form, { onSuccess: onClose })}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function HoursDialog({ location, onClose }: { location: FacilityLocation; onClose: () => void }) {
  const [week, setWeek] = useState<DayHours[]>(() => weekFrom(location.hours));
  const save = useFacilityChange((w: DayHours[]) => facilityPortalService.setHours(location.locationId, w), 'Opening hours saved.');
  const problem = hoursProblem(week);
  const setDay = (weekday: number, change: Partial<DayHours>) => setWeek((w) => w.map((d) => (d.weekday === weekday ? { ...d, ...change } : d)));
  return (
    <Dialog open onClose={save.isPending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Opening hours — {location.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          {week.map((d) => (
            <Stack key={d.weekday} direction="row" spacing={1.5} alignItems="center">
              <FormControlLabel sx={{ width: 150 }} control={<Checkbox checked={d.open} onChange={(e) => setDay(d.weekday, { open: e.target.checked })} />} label={WEEKDAYS[d.weekday]} />
              {d.open ? (
                <>
                  <TextField size="small" type="time" label="Opens" value={d.openTime} onChange={(e) => setDay(d.weekday, { openTime: e.target.value })} InputLabelProps={{ shrink: true }} />
                  <TextField size="small" type="time" label="Closes" value={d.closeTime} onChange={(e) => setDay(d.weekday, { closeTime: e.target.value })} InputLabelProps={{ shrink: true }} />
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Closed
                </Typography>
              )}
            </Stack>
          ))}
          {problem ? <Alert severity="warning">{problem}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!!problem || save.isPending} onClick={() => save.mutate(week, { onSuccess: onClose })}>
          Save hours
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function FacilitiesDialog({ location, onClose }: { location: FacilityLocation; onClose: () => void }) {
  const [chosen, setChosen] = useState<string[]>(location.facilities);
  const [other, setOther] = useState('');
  const save = useFacilityChange((list: string[]) => facilityPortalService.setFacilities(location.locationId, list), 'Facilities saved.');
  const options = [...new Set([...SUGGESTED_FACILITIES, ...chosen])];
  const toggle = (f: string) => setChosen((c) => (c.includes(f) ? c.filter((x) => x !== f) : [...c, f]));
  return (
    <Dialog open onClose={save.isPending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Facilities — {location.name}</DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1, pt: 0.5 }}>
          {options.map((f) => (
            <Chip key={f} label={f} color={chosen.includes(f) ? 'primary' : 'default'} variant={chosen.includes(f) ? 'filled' : 'outlined'} onClick={() => toggle(f)} />
          ))}
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <TextField size="small" fullWidth label="Another facility" value={other} onChange={(e) => setOther(e.target.value)} inputProps={{ maxLength: 60 }} />
          <Button
            variant="outlined"
            disabled={other.trim().length < 2 || chosen.length >= 30}
            onClick={() => {
              if (!chosen.includes(other.trim())) setChosen((c) => [...c, other.trim()]);
              setOther('');
            }}
          >
            Add
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button variant="contained" disabled={save.isPending} onClick={() => save.mutate(chosen, { onSuccess: onClose })}>
          Save facilities
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Work 164: the facility's locations — each with its map position (search measures distance to
 * the main one), emergency service, opening hours and facilities.
 */
export function FacilityLocationsPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const canManage = can('facility:manage');
  const profile = useFacilityProfile();
  const [editing, setEditing] = useState<{ form: LocationForm; locationId: string | null } | null>(null);
  const [hours, setHours] = useState<FacilityLocation | null>(null);
  const [facilities, setFacilities] = useState<FacilityLocation | null>(null);
  const [removing, setRemoving] = useState<FacilityLocation | null>(null);
  const remove = useFacilityChange((id: string) => facilityPortalService.removeLocation(id), 'Location removed.');
  const p = profile.data;
  const suspended = p?.status === 'SUSPENDED';

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Locations"
        subtitle="Where customers find you. Every location needs its map position."
        actions={
          canManage && !suspended ? (
            <Button variant="contained" startIcon={<AddLocationAltRoundedIcon />} onClick={() => setEditing({ form: { ...EMPTY, isPrimary: (p?.locations.length ?? 0) === 0 }, locationId: null })}>
              Add location
            </Button>
          ) : undefined
        }
      />
      {profile.isLoading ? <Skeleton variant="rounded" height={200} /> : null}
      {profile.error ? <Alert severity="error">{facilityErrorMessage(profile.error, 'Your facility could not be loaded.')}</Alert> : null}
      {p && p.locations.length === 0 ? <Alert severity="info">No locations yet. Add your first one so customers can find you.</Alert> : null}
      <Stack spacing={2}>
        {p?.locations.map((l) => (
          <Card key={l.locationId}>
            <CardContent>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1}>
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h6">{l.name}</Typography>
                    {l.isPrimary ? <Chip size="small" color="primary" label="Main" /> : null}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {[l.addressLine, l.woreda ? `Woreda ${l.woreda}` : null, l.subcity, l.city].filter(Boolean).join(', ')}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {EMERGENCY_LABELS[l.emergencyAvailability] ?? l.emergencyAvailability}
                    {l.phone ? ` · ${l.phone}` : ''}
                    {l.lat !== null && l.lng !== null ? ` · ${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}` : ''}
                  </Typography>
                </Box>
                {canManage && !suspended ? (
                  <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                    <Button size="small" onClick={() => setEditing({ form: formFrom(l), locationId: l.locationId })}>
                      Edit
                    </Button>
                    <Button size="small" onClick={() => setHours(l)}>
                      Hours
                    </Button>
                    <Button size="small" onClick={() => setFacilities(l)}>
                      Facilities
                    </Button>
                    <Button size="small" color="error" onClick={() => setRemoving(l)}>
                      Remove
                    </Button>
                  </Stack>
                ) : null}
              </Stack>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ mt: 1.5 }}>
                <Box sx={{ minWidth: 240 }}>
                  <Typography variant="subtitle2">Opening hours</Typography>
                  {l.hours.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      Not set
                    </Typography>
                  ) : (
                    l.hours.map((h) => (
                      <Typography key={h.weekday} variant="body2" color="text.secondary">
                        {WEEKDAYS[h.weekday]}: {h.isClosed ? 'Closed' : `${h.openTime}–${h.closeTime}`}
                      </Typography>
                    ))
                  )}
                </Box>
                <Box>
                  <Typography variant="subtitle2">Facilities</Typography>
                  {l.facilities.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      None listed
                    </Typography>
                  ) : (
                    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mt: 0.5 }}>
                      {l.facilities.map((f) => (
                        <Chip key={f} size="small" variant="outlined" label={f} />
                      ))}
                    </Stack>
                  )}
                </Box>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>

      {editing ? <LocationDialog initial={editing.form} locationId={editing.locationId} onClose={() => setEditing(null)} /> : null}
      {hours ? <HoursDialog location={hours} onClose={() => setHours(null)} /> : null}
      {facilities ? <FacilitiesDialog location={facilities} onClose={() => setFacilities(null)} /> : null}
      <ConfirmDialog
        open={!!removing}
        title="Remove this location?"
        message={`${removing?.name ?? ''} stops appearing to customers. Services offered only there are offered by your other locations.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removing) remove.mutate(removing.locationId);
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}
