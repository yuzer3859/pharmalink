import { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Chip, Grid, Skeleton, Stack, TextField, Typography } from '@mui/material';
import { PageHeader } from '@/components/common/PageHeader';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { providerTypeLabel } from '@/services/adminProviders.service';
import { facilityPortalService, profileProblem, type ProfileForm } from '@/services/facilityPortal.service';
import { formatDate } from '@/utils/format';
import { facilityErrorMessage, useFacilityChange, useFacilityProfile } from './useFacility';

const EMPTY: ProfileForm = { nameEn: '', nameAm: '', description: '', website: '', contactPhone: '', contactEmail: '' };

/**
 * Work 164: the facility's profile — what customers see about it — with its status and licence.
 * The name customers see is set by PharmaLink at registration; everything else is edited here.
 */
export function FacilityProfilePage() {
  const portal = usePortal();
  const { can } = useAuth();
  const canManage = can('facility:manage');
  const profile = useFacilityProfile();
  const [form, setForm] = useState<ProfileForm>(EMPTY);
  const save = useFacilityChange((f: ProfileForm) => facilityPortalService.updateProfile(f), 'Profile saved. Customers see the change in search shortly.');

  const p = profile.data;
  useEffect(() => {
    if (p) {
      setForm({
        nameEn: p.nameEn ?? '',
        nameAm: p.nameAm ?? '',
        description: p.description ?? '',
        website: p.website ?? '',
        contactPhone: p.contactPhone ?? '',
        contactEmail: p.contactEmail ?? '',
      });
    }
  }, [p]);

  const problem = profileProblem(form);
  const field = (key: keyof ProfileForm, label: string, extra: Record<string, unknown> = {}) => (
    <TextField fullWidth size="small" label={label} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} disabled={!canManage} {...extra} />
  );

  return (
    <>
      <PageHeader portalName={portal.title} title="Profile" subtitle="What customers see about your facility in PharmaLink search." />
      {profile.isLoading ? <Skeleton variant="rounded" height={260} /> : null}
      {profile.error ? <Alert severity="error">{facilityErrorMessage(profile.error, 'Your facility could not be loaded.')}</Alert> : null}
      {p ? (
        <Grid container spacing={2}>
          <Grid item xs={12} md={4}>
            <Card>
              <CardContent>
                <Typography variant="h6">{p.displayName}</Typography>
                <Stack direction="row" spacing={1} sx={{ my: 1 }}>
                  <Chip size="small" label={providerTypeLabel(p.type)} />
                  <StatusChip status={p.status.toLowerCase()} />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  Licence valid until {p.licenseExpiresAt ? formatDate(p.licenseExpiresAt) : '—'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {p.locations.length} location{p.locations.length === 1 ? '' : 's'} · {p.departments.filter((d) => d.isActive).length} open departments · {p.services.length} services
                </Typography>
                {p.status === 'SUSPENDED' ? (
                  <Alert severity="warning" sx={{ mt: 2 }}>
                    PharmaLink has disabled your facility. It does not appear to customers and cannot be changed.
                  </Alert>
                ) : null}
                {p.locations.length === 0 && p.status !== 'SUSPENDED' ? (
                  <Alert severity="info" sx={{ mt: 2 }}>
                    Add a location so customers can find you nearby.
                  </Alert>
                ) : null}
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} md={8}>
            <Card>
              <CardContent>
                <Stack spacing={2}>
                  <Typography variant="subtitle2">Details</Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    {field('nameEn', 'Name in English', { inputProps: { maxLength: 200 } })}
                    {field('nameAm', 'Name in Amharic', { inputProps: { maxLength: 200, lang: 'am' } })}
                  </Stack>
                  {field('description', 'About the facility', { multiline: true, minRows: 3, inputProps: { maxLength: 2000 } })}
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    {field('contactPhone', 'Phone')}
                    {field('contactEmail', 'E-mail')}
                  </Stack>
                  {field('website', 'Website (https://…)')}
                  {problem ? <Alert severity="warning">{problem}</Alert> : null}
                  {canManage ? (
                    <Box>
                      <Button variant="contained" disabled={!!problem || save.isPending || p.status === 'SUSPENDED'} onClick={() => save.mutate(form)}>
                        {save.isPending ? 'Saving…' : 'Save profile'}
                      </Button>
                    </Box>
                  ) : null}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      ) : null}
    </>
  );
}
