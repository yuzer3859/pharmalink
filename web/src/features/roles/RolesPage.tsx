import { useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Grid,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import PeopleAltRoundedIcon from '@mui/icons-material/PeopleAltRounded';
import { PageHeader } from '@/components/common/PageHeader';
import { LoadingScreen } from '@/components/common/LoadingScreen';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { RoleFormDialog } from './RoleFormDialog';
import { useRoles, useRoleMutations } from '@/hooks/useRoles';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import type { Role } from '@/types';

export function RolesPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const canManage = can('roles:manage');

  const { data = [], isLoading } = useRoles();
  const { remove } = useRoleMutations();

  const [editing, setEditing] = useState<Role | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Role | null>(null);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (role: Role) => {
    setEditing(role);
    setFormOpen(true);
  };

  if (isLoading) return <LoadingScreen />;

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Role Management"
        subtitle="Define roles and fine-grained permissions for platform access."
        actions={
          canManage ? (
            <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={openCreate}>
              Create Role
            </Button>
          ) : undefined
        }
      />

      <Grid container spacing={2.5}>
        {data.map((role) => (
          <Grid item xs={12} sm={6} md={4} key={role.id}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                  <Box>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <Typography variant="h6">{role.name}</Typography>
                      {role.isSystem && (
                        <Tooltip title="System role">
                          <LockRoundedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                        </Tooltip>
                      )}
                    </Stack>
                    <Chip
                      label={role.portal}
                      size="small"
                      variant="outlined"
                      sx={{ mt: 0.5, textTransform: 'capitalize' }}
                    />
                  </Box>
                  {canManage && (
                    <Stack direction="row">
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(role)}>
                          <EditRoundedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={role.isSystem ? 'System roles cannot be deleted' : 'Delete'}>
                        <span>
                          <IconButton
                            size="small"
                            disabled={role.isSystem}
                            onClick={() => setToDelete(role)}
                          >
                            <DeleteOutlineRoundedIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  )}
                </Stack>

                <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, minHeight: 40 }}>
                  {role.description}
                </Typography>

                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 2 }}>
                  <PeopleAltRoundedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                  <Typography variant="body2" color="text.secondary">
                    {role.memberCount} members
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Chip label={`${role.permissions.length} permissions`} size="small" />
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <RoleFormDialog
        open={formOpen}
        role={editing}
        portalKey={portal.key}
        onClose={() => setFormOpen(false)}
      />

      <ConfirmDialog
        open={!!toDelete}
        title="Delete role"
        message={`Delete the "${toDelete?.name}" role? Members will need to be reassigned.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}
