import { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Chip, FormControlLabel, Grid, Skeleton, Stack, Switch, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { StatusChip } from '@/components/common/StatusChip';
import { useNotify } from '@/context/NotificationContext';
import { usePortal } from '@/hooks/usePortal';
import { providerTypeLabel } from '@/services/adminProviders.service';
import { ApiError } from '@/services/apiClient';
import { doctorPortalService, profileFormFrom, profileProblem, type ProfileForm } from '@/services/doctorPortal.service';
import { formatDate } from '@/utils/format';

/**
 * Work 170: the doctor's professional profile (Work 166) — what patients see — with where they
 * practise and their licence. The name, specialty and licence are set by PharmaLink.
 */
export function DoctorProfilePage() {
  const portal = usePortal();
  const qc = useQueryClient();
  const notify = useNotify();
  const profile = useQuery({ queryKey: ['doctor', 'profile'], queryFn: () => doctorPortalService.profile() });
  const [form, setForm] = useState<ProfileForm | null>(null);
  useEffect(() => {
    if (profile.data) setForm(profileFormFrom(profile.data));
  }, [profile.data]);
  const save = useMutation({
    mutationFn: (f: ProfileForm) => doctorPortalService.updateProfile(f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['doctor'] });
      notify('Profile saved. Patients see the change shortly.');
    },
    onError: (e) => notify(e instanceof ApiError ? e.message : 'The profile could not be saved.', 'error'),
  });
  const p = profile.data;
  const problem = form ? profileProblem(form) : null;
  const field = (key: keyof ProfileForm, label: string, extra: Record<string, unknown> = {}) =>
    form ? <TextField fullWidth size="small" label={label} value={form[key] as string} onChange={(e) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f))} {...extra} /> : null;

  return (
    <>
      <PageHeader portalName={portal.title} title="Profile" subtitle="What patients see about you." />
      {profile.isLoading ? <Skeleton variant="rounded" height={260} /> : null}
      {profile.error ? <Alert severity="error">{profile.error instanceof ApiError ? profile.error.message : 'Your profile could not be loaded.'}</Alert> : null}
      {p && form ? (
        <Grid container spacing={2}>
          <Grid item xs={12} md={4}>
            <Card>
              <CardContent>
                <Typography variant="h6">{p.fullName}</Typography>
                <Stack direction="row" spacing={1} sx={{ my: 1 }}>
                  {p.specialty ? <Chip size="small" label={p.specialty} /> : null}
                  <StatusChip status={p.status.toLowerCase()} />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  Licence {p.licenseNumber ?? '—'}, valid until {p.licenseExpiresAt ? formatDate(p.licenseExpiresAt) : '—'}
                </Typography>
                <Typography variant="subtitle2" sx={{ mt: 2 }}>
                  Where you practise
                </Typography>
                {p.affiliations.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No facility yet. A hospital or clinic adds you from its portal.
                  </Typography>
                ) : (
                  p.affiliations.map((a) => (
                    <Typography key={a.providerId} variant="body2" color="text.secondary">
                      {a.providerName} ({providerTypeLabel(a.providerType)}){a.departmentName ? `, ${a.departmentName}` : ''}
                    </Typography>
                  ))
                )}
                {p.status === 'SUSPENDED' ? (
                  <Alert severity="warning" sx={{ mt: 2 }}>
                    PharmaLink has disabled your profile. Patients cannot find or book you.
                  </Alert>
                ) : null}
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} md={8}>
            <Card>
              <CardContent>
                <Stack spacing={2}>
                  {field('fullNameAm', 'Name in Amharic', { inputProps: { maxLength: 200, lang: 'am' } })}
                  {field('subSpecialties', 'Sub-specialties (separated by commas)')}
                  {field('qualifications', 'Qualifications (separated by commas)')}
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    {field('yearsExperience', 'Years of experience', { inputProps: { inputMode: 'numeric' } })}
                    {field('languages', 'Languages (e.g. Amharic, English)')}
                  </Stack>
                  {field('bio', 'About you', { multiline: true, minRows: 3, inputProps: { maxLength: 3000 } })}
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    {field('feeInPerson', 'Fee in person (birr)', { inputProps: { inputMode: 'decimal' } })}
                    {field('feeTele', 'Fee by video (birr)', { inputProps: { inputMode: 'decimal' }, disabled: !form.acceptsTelemedicine })}
                  </Stack>
                  <FormControlLabel
                    control={<Switch checked={form.acceptsTelemedicine} onChange={(e) => setForm((f) => (f ? { ...f, acceptsTelemedicine: e.target.checked } : f))} />}
                    label="I see patients by video"
                  />
                  {problem ? <Alert severity="warning">{problem}</Alert> : null}
                  <Box>
                    <Button variant="contained" disabled={!!problem || save.isPending} onClick={() => save.mutate(form)}>
                      {save.isPending ? 'Saving…' : 'Save profile'}
                    </Button>
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    Patients pay your fee at the visit.
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      ) : null}
    </>
  );
}
