import { Alert, Card, CardContent, Grid, Skeleton, Stack, Typography } from '@mui/material';
import { PageHeader } from '@/components/common/PageHeader';
import { usePortal } from '@/hooks/usePortal';
import { staffErrorMessage, usePharmacyStaff } from '@/hooks/usePharmacyStaff';
import { describePermissions } from '@/services/pharmacyStaff.service';

/**
 * Work 114: the pharmacy staff roles, read-only. They are PharmaLink's system roles; a pharmacy
 * gives them to staff on the Staff page and cannot define its own. What each one allows comes from
 * the RBAC catalogue through `GET /pharmacy/staff`.
 */
export function RolesPage() {
  const portal = usePortal();
  const { data, isLoading, error } = usePharmacyStaff();
  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Roles"
        subtitle="What each staff role can do at your pharmacy. Give roles to people on the Staff page."
      />
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{staffErrorMessage(error, 'Roles could not be loaded.')}</Alert> : null}
      {isLoading ? <Skeleton variant="rounded" height={200} /> : null}
      <Grid container spacing={2}>
        {(data?.assignableRoles ?? []).map((role) => (
          <Grid item xs={12} md={6} key={role.key}>
            <Card variant="outlined" sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6">{role.name}</Typography>
                {role.description ? (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    {role.description}
                  </Typography>
                ) : null}
                <Stack component="ul" spacing={0.5} sx={{ pl: 2, m: 0 }}>
                  {describePermissions(role.permissionKeys).map((p) => (
                    <Typography component="li" variant="body2" key={p}>
                      {p}
                    </Typography>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </>
  );
}
