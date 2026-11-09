import { useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import PersonAddRoundedIcon from '@mui/icons-material/PersonAddRounded';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { staffErrorMessage, usePharmacyStaff, useStaffActions } from '@/hooks/usePharmacyStaff';
import { canRemoveRole, emailProblem, type AssignableRole, type StaffMember } from '@/services/pharmacyStaff.service';

function AddStaffDialog({ roles, onClose }: { roles: AssignableRole[]; onClose: () => void }) {
  const { add } = useStaffActions();
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? '');
  const problem = emailProblem(email) ?? (roleKey ? null : 'Choose a role.');
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Add staff</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            They need a PharmaLink account first: ask them to sign up, then add them here with the same e-mail address.
          </Typography>
          <TextField size="small" label="Their e-mail" value={email} onChange={(e) => setEmail(e.target.value)} error={email !== '' && !!emailProblem(email)} helperText={email !== '' ? emailProblem(email) ?? ' ' : ' '} />
          <TextField select size="small" label="Role" value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
            {roles.map((r) => (
              <MenuItem key={r.key} value={r.key}>
                {r.name}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!!problem || add.isPending} onClick={() => add.mutate({ email, roleKey }, { onSuccess: onClose })}>
          Give role
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Work 114: the pharmacy's staff on the real API (Work 113). Members and their roles; the owner or
 * a manager gives an existing account a staff role by e-mail, and takes a staff role away. The
 * owner role and one's own roles are never removable.
 */
export function StaffPage() {
  const portal = usePortal();
  const { user, can } = useAuth();
  const canManage = can('staff:manage');
  const { data, isLoading, error } = usePharmacyStaff();
  const { removeRole } = useStaffActions();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ member: StaffMember; roleKey: string; roleName: string } | null>(null);
  const assignable = data?.assignableRoles ?? [];

  const columns: GridColDef<StaffMember>[] = [
    { field: 'email', headerName: 'Account', flex: 1, minWidth: 220, valueGetter: (_v, row) => row.email ?? row.phone ?? row.userId },
    {
      field: 'roles',
      headerName: 'Roles',
      flex: 1,
      minWidth: 280,
      sortable: false,
      renderCell: ({ row }) => (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', py: 0.5 }}>
          {row.roles.map((r) => (
            <Chip
              key={r.roleKey}
              size="small"
              label={r.roleName}
              onDelete={canManage && canRemoveRole(row.userId, r.roleKey, user?.id, assignable) ? () => setRemoving({ member: row, roleKey: r.roleKey, roleName: r.roleName }) : undefined}
            />
          ))}
        </Stack>
      ),
    },
    { field: 'status', headerName: 'Account status', width: 150, renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} /> },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Staff"
        subtitle="People who work for your pharmacy on PharmaLink, and their roles."
        actions={canManage ? <Button variant="contained" startIcon={<PersonAddRoundedIcon />} disabled={assignable.length === 0} onClick={() => setAdding(true)}>Add staff</Button> : undefined}
      />
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{staffErrorMessage(error, 'Staff could not be loaded.')}</Alert> : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as StaffMember).userId}
        loading={isLoading}
        pageSize={25}
        emptyTitle="No staff yet"
        emptyDescription="Add the people who work at your pharmacy."
      />
      {adding ? <AddStaffDialog roles={assignable} onClose={() => setAdding(false)} /> : null}
      <ConfirmDialog
        open={!!removing}
        title="Remove role"
        message={removing ? `Remove the ${removing.roleName} role from ${removing.member.email ?? 'this account'}? They lose what it allows at your pharmacy the next time they sign in.` : ''}
        confirmLabel="Remove"
        destructive
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && removeRole.mutate({ userId: removing.member.userId, roleKey: removing.roleKey }, { onSettled: () => setRemoving(null) })}
      />
    </>
  );
}
