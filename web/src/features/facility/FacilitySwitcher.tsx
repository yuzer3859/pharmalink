import { useEffect, useSyncExternalStore } from 'react';
import { MenuItem, TextField } from '@mui/material';
import LocalHospitalRoundedIcon from '@mui/icons-material/LocalHospitalRounded';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { facilityPortalService } from '@/services/facilityPortal.service';
import { onOrganizationSelected, selectedOrganizationId, selectOrganization } from '@/services/pharmacySelection';

/**
 * Work 164: for an administrator who runs several facilities, which one the portal works in —
 * the facility twin of Work 155's pharmacy switcher, using the same `X-Organization-Id` choice.
 * Hidden for a single facility.
 */
export function FacilitySwitcher() {
  const qc = useQueryClient();
  const chosen = useSyncExternalStore(onOrganizationSelected, selectedOrganizationId);
  const { data } = useQuery({ queryKey: ['my-facilities'], queryFn: () => facilityPortalService.mine(), staleTime: 60_000 });
  const facilities = data ?? [];

  useEffect(() => {
    if (data && chosen && !data.some((f) => f.organizationId === chosen)) selectOrganization(null);
  }, [data, chosen]);

  if (facilities.length < 2) return null;
  const current = facilities.find((f) => f.organizationId === chosen) ?? facilities[0];

  return (
    <TextField
      select
      size="small"
      label="Facility"
      value={current.organizationId}
      onChange={(e) => {
        selectOrganization(e.target.value);
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'my-facilities' });
        qc.invalidateQueries();
      }}
      InputProps={{ startAdornment: <LocalHospitalRoundedIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} /> }}
      sx={{ minWidth: { xs: 160, sm: 240 } }}
    >
      {facilities.map((f) => (
        <MenuItem key={f.organizationId} value={f.organizationId}>
          {f.displayName}
          {f.status !== 'ACTIVE' ? ` (${f.status.toLowerCase()})` : ''}
        </MenuItem>
      ))}
    </TextField>
  );
}
