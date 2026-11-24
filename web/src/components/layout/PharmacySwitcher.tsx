import { useEffect, useSyncExternalStore } from 'react';
import { MenuItem, TextField } from '@mui/material';
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { myPharmaciesService } from '@/services/myPharmacies.service';
import { onOrganizationSelected, selectedOrganizationId, selectOrganization } from '@/services/pharmacySelection';

/**
 * Work 155: for someone who works in several pharmacies (an owner of more than one, or a
 * pharmacist at more than one), which one the portal works in. Hidden for a single pharmacy.
 * Switching reloads every page's data for the chosen pharmacy.
 */
export function PharmacySwitcher() {
  const qc = useQueryClient();
  const chosen = useSyncExternalStore(onOrganizationSelected, selectedOrganizationId);
  const { data } = useQuery({ queryKey: ['my-pharmacies'], queryFn: () => myPharmaciesService.list(), staleTime: 60_000 });
  const pharmacies = data ?? [];

  // A remembered choice that is no longer one of theirs (removed, or another account) is dropped.
  useEffect(() => {
    if (data && chosen && !data.some((p) => p.organizationId === chosen)) selectOrganization(null);
  }, [data, chosen]);

  if (pharmacies.length < 2) return null;
  const current = pharmacies.find((p) => p.organizationId === chosen) ?? pharmacies[0];

  return (
    <TextField
      select
      size="small"
      label="Pharmacy"
      value={current.organizationId}
      onChange={(e) => {
        selectOrganization(e.target.value);
        // Every query belongs to the previous pharmacy; the list of pharmacies itself does not change.
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'my-pharmacies' });
        qc.invalidateQueries();
      }}
      InputProps={{ startAdornment: <StorefrontRoundedIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} /> }}
      sx={{ minWidth: { xs: 160, sm: 240 } }}
    >
      {pharmacies.map((p) => (
        <MenuItem key={p.organizationId} value={p.organizationId}>
          {p.displayName}
          {p.transactingStatus !== 'ACTIVE' ? ` (${p.transactingStatus.toLowerCase()})` : ''}
        </MenuItem>
      ))}
    </TextField>
  );
}
