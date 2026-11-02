import { Alert, Box, Chip, Stack, Typography } from '@mui/material';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { useRoleCatalogue } from '@/hooks/useAdminAccounts';
import { usePortal } from '@/hooks/usePortal';
import { accountErrorMessage } from '@/services/adminAccounts.service';
import type { RoleCatalogueEntry } from '@/types';

/**
 * The role catalogue for administrators (`GET /admin/roles`, `rbac:read`): each role, its scope and
 * its permissions. Read-only: roles and their permissions come from the RBAC seed and there is no
 * API to create or edit them. Assigning roles to accounts is on the Accounts page.
 */
export function AdminRolesPage() {
  const portal = usePortal();
  const { data = [], isLoading, error } = useRoleCatalogue();

  const columns: GridColDef<RoleCatalogueEntry>[] = [
    {
      field: 'name',
      headerName: 'Role',
      flex: 1,
      minWidth: 200,
      renderCell: ({ row }) => (
        <Box sx={{ py: 1 }}>
          <Typography variant="body2">{row.name}</Typography>
          <Typography variant="caption" color="text.secondary">
            {row.key}
          </Typography>
        </Box>
      ),
    },
    { field: 'scope', headerName: 'Scope', width: 120, valueFormatter: (v: string) => v.toLowerCase() },
    { field: 'isSystem', headerName: 'System', width: 90, valueFormatter: (v: boolean) => (v ? 'Yes' : 'No') },
    {
      field: 'permissions',
      headerName: 'Permissions',
      flex: 2.5,
      minWidth: 320,
      sortable: false,
      renderCell: ({ row }) => (
        <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ py: 1 }}>
          {row.permissions.map((p) => (
            <Chip key={p} label={p} size="small" variant="outlined" />
          ))}
        </Stack>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Roles"
        subtitle="The role catalogue and each role's permissions. Roles are defined by the platform seed and cannot be edited here."
      />
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {accountErrorMessage(error, 'Roles could not be loaded.')}
        </Alert>
      ) : null}
      <DataTable
        rows={data}
        columns={columns as GridColDef[]}
        loading={isLoading}
        pageSize={25}
        emptyTitle="No roles"
        emptyDescription="Run the RBAC seed to create the role catalogue."
      />
    </>
  );
}
