import { useMemo, useState } from 'react';
import { Avatar, Button, IconButton, MenuItem, Stack, TextField, Tooltip } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { SearchInput } from '@/components/common/SearchInput';
import { StaffFormDialog } from './StaffFormDialog';
import { useStaff, useStaffMutations } from '@/hooks/useStaff';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { initials, relativeTime } from '@/utils/format';
import type { StaffMember } from '@/types';

export function StaffPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const canManage = can('staff:manage');

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StaffMember['status'] | 'all'>('all');
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const filters = useMemo(() => ({ search, status }), [search, status]);
  const { data = [], isLoading } = useStaff(filters);
  const { update } = useStaffMutations();

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (member: StaffMember) => {
    setEditing(member);
    setFormOpen(true);
  };

  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: 'Name',
      flex: 1.2,
      minWidth: 200,
      renderCell: (params) => {
        const row = params.row as StaffMember;
        return (
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ height: '100%' }}>
            <Avatar sx={{ width: 32, height: 32, fontSize: 13, bgcolor: portal.accent }}>
              {initials(row.name)}
            </Avatar>
            <span>{row.name}</span>
          </Stack>
        );
      },
    },
    { field: 'email', headerName: 'Email', flex: 1.3, minWidth: 220 },
    { field: 'roleName', headerName: 'Role', flex: 1, minWidth: 150 },
    ...(portal.key !== 'pharmacy'
      ? [{ field: 'pharmacyName', headerName: 'Pharmacy', flex: 1, minWidth: 150 } as GridColDef]
      : []),
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      renderCell: (params) => <StatusChip status={params.value as string} />,
    },
    {
      field: 'lastActiveAt',
      headerName: 'Last active',
      width: 130,
      valueFormatter: (value: string) => relativeTime(value),
    },
    {
      field: 'actions',
      headerName: '',
      width: 100,
      sortable: false,
      filterable: false,
      renderCell: (params) => {
        const row = params.row as StaffMember;
        if (!canManage) return null;
        const suspended = row.status === 'suspended';
        return (
          <Stack direction="row">
            <Tooltip title="Edit">
              <IconButton size="small" onClick={() => openEdit(row)}>
                <EditRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={suspended ? 'Reactivate' : 'Suspend'}>
              <IconButton
                size="small"
                color={suspended ? 'success' : 'error'}
                onClick={() =>
                  update.mutate({ id: row.id, patch: { status: suspended ? 'active' : 'suspended' } })
                }
              >
                {suspended ? (
                  <CheckCircleRoundedIcon fontSize="small" />
                ) : (
                  <BlockRoundedIcon fontSize="small" />
                )}
              </IconButton>
            </Tooltip>
          </Stack>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Staff Management"
        subtitle="Invite team members, assign roles and manage access."
        actions={
          canManage ? (
            <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={openCreate}>
              Invite Staff
            </Button>
          ) : undefined
        }
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name or email" />
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as StaffMember['status'] | 'all')}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="all">All statuses</MenuItem>
          <MenuItem value="active">Active</MenuItem>
          <MenuItem value="invited">Invited</MenuItem>
          <MenuItem value="suspended">Suspended</MenuItem>
        </TextField>
      </Stack>

      <DataTable
        rows={data}
        columns={columns}
        loading={isLoading}
        emptyTitle="No staff found"
        emptyDescription="Invite team members to collaborate in this workspace."
      />

      <StaffFormDialog open={formOpen} member={editing} onClose={() => setFormOpen(false)} />
    </>
  );
}
