import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAccountActions, useAdminAccount, useAdminAccounts, useRoleCatalogue } from '@/hooks/useAdminAccounts';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import {
  ACCOUNT_PAGE_SIZES,
  ACCOUNT_STATUSES,
  accountErrorMessage,
  isIdentifierFilter,
  isValidReason,
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  PRIMARY_ROLES,
} from '@/services/adminAccounts.service';
import { humanizeStatus } from '@/services/adminAnalytics.service';
import { formatDateTime } from '@/utils/format';
import type { AccountStatus, AdminAccount, AdminAccountDetail, PrimaryRole } from '@/types';

const SUSPENDABLE: AccountStatus[] = ['ACTIVE', 'PENDING_VERIFICATION'];

function ReasonDialog({
  open,
  title,
  required,
  busy,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  required: boolean;
  busy: boolean;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const empty = reason.trim() === '';
  const valid = isValidReason(reason) || (!required && empty);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={3}
          margin="dense"
          label={required ? 'Reason (recorded in the audit trail)' : 'Reason (optional, recorded in the audit trail)'}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={!empty && !isValidReason(reason)}
          helperText={`${MIN_REASON_LENGTH}–${MAX_REASON_LENGTH} characters.`}
          inputProps={{ maxLength: MAX_REASON_LENGTH }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid || busy} onClick={() => onSubmit(reason)}>
          Confirm
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AssignRole({ account, busy, onAssign }: { account: AdminAccountDetail; busy: boolean; onAssign: (roleKey: string, organizationId?: string) => void }) {
  const { data: roles = [] } = useRoleCatalogue();
  const [roleKey, setRoleKey] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const role = roles.find((r) => r.key === roleKey);
  const needsOrg = role?.scope === 'ORG';
  const ready = !!role && (!needsOrg || organizationId.trim() !== '');
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">Assign a role</Typography>
      <TextField select size="small" label="Role" value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
        {roles.map((r) => (
          <MenuItem key={r.key} value={r.key}>
            {r.name} ({r.scope.toLowerCase()})
          </MenuItem>
        ))}
      </TextField>
      {needsOrg ? (
        <TextField size="small" label="Organisation id" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} />
      ) : null}
      <Button
        variant="outlined"
        size="small"
        disabled={!ready || busy}
        onClick={() => {
          onAssign(roleKey, needsOrg ? organizationId : undefined);
          setRoleKey('');
          setOrganizationId('');
        }}
      >
        Assign to {account.email ?? account.phone ?? 'account'}
      </Button>
    </Stack>
  );
}

function AccountDrawer({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const { data: account, isLoading, error } = useAdminAccount(userId);
  const actions = useAccountActions();
  const [dialog, setDialog] = useState<'suspend' | 'reinstate' | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const canSuspend = can('staff:manage');
  const canManageRoles = can('roles:manage');

  return (
    <Drawer anchor="right" open={!!userId} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 460 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">Account</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{accountErrorMessage(error, 'The account could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={260} /> : null}
        {account ? (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} alignItems="center">
              <StatusChip status={account.status.toLowerCase()} />
              <Typography variant="body2" color="text.secondary">
                {humanizeStatus(account.primaryRole)}
              </Typography>
            </Stack>
            <Typography variant="body2">E-mail: {account.email ?? '—'} {account.emailVerifiedAt ? '(verified)' : ''}</Typography>
            <Typography variant="body2">Phone: {account.phone ?? '—'} {account.phoneVerifiedAt ? '(verified)' : ''}</Typography>
            <Typography variant="body2">Fayda verified: {account.faydaVerifiedAt ? formatDateTime(account.faydaVerifiedAt) : 'No'}</Typography>
            <Typography variant="body2">Created: {formatDateTime(account.createdAt)}</Typography>

            {canSuspend ? (
              <Stack direction="row" spacing={1}>
                {SUSPENDABLE.includes(account.status) ? (
                  <Button color="error" variant="outlined" size="small" onClick={() => setDialog('suspend')}>
                    Suspend
                  </Button>
                ) : null}
                {account.status === 'SUSPENDED' ? (
                  <Button color="success" variant="outlined" size="small" onClick={() => setDialog('reinstate')}>
                    Reinstate
                  </Button>
                ) : null}
              </Stack>
            ) : null}

            <Divider />
            <Typography variant="subtitle2">Roles ({account.roles.length})</Typography>
            {account.roles.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No role assignments.
              </Typography>
            ) : (
              account.roles.map((r) => (
                <Stack key={r.assignmentId} direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
                  <Box>
                    <Typography variant="body2">{r.roleName}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {r.organizationId ? `Organisation ${r.organizationId.slice(0, 8)}…` : 'Platform-wide'} · since {formatDateTime(r.createdAt)}
                    </Typography>
                  </Box>
                  {canManageRoles ? (
                    <IconButton size="small" aria-label={`Revoke ${r.roleName}`} onClick={() => setRevoking(r.assignmentId)}>
                      <DeleteOutlineRoundedIcon fontSize="small" />
                    </IconButton>
                  ) : null}
                </Stack>
              ))
            )}

            {canManageRoles ? (
              <AssignRole
                account={account}
                busy={actions.assignRole.isPending}
                onAssign={(roleKey, organizationId) => actions.assignRole.mutate({ userId: account.userId, roleKey, organizationId })}
              />
            ) : null}

            <ReasonDialog
              key={dialog ?? 'closed'}
              open={dialog !== null}
              title={dialog === 'suspend' ? 'Suspend this account?' : 'Reinstate this account?'}
              required={dialog === 'suspend'}
              busy={actions.suspend.isPending || actions.reinstate.isPending}
              onClose={() => setDialog(null)}
              onSubmit={(reason) => {
                if (dialog === 'suspend') actions.suspend.mutate({ userId: account.userId, reason });
                else actions.reinstate.mutate({ userId: account.userId, reason });
                setDialog(null);
              }}
            />
            <ConfirmDialog
              open={revoking !== null}
              title="Revoke this role?"
              message="The account loses the role's permissions immediately. The change is audited."
              confirmLabel="Revoke"
              destructive
              onClose={() => setRevoking(null)}
              onConfirm={() => {
                if (revoking) actions.revokeRole.mutate({ userId: account.userId, assignmentId: revoking });
                setRevoking(null);
              }}
            />
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * Accounts for administrators (`GET /admin/accounts`, `rbac:read`): search by exact phone or
 * e-mail, status and primary role; suspend and reinstate with an audited reason; assign and revoke
 * roles. The pharmacy portal keeps its own Staff page.
 */
export function AdminStaffPage() {
  const portal = usePortal();
  const [status, setStatus] = useState<AccountStatus | 'all'>('all');
  const [primaryRole, setPrimaryRole] = useState<PrimaryRole | 'all'>('all');
  const [identifier, setIdentifier] = useState('');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: ACCOUNT_PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);

  const identifierInvalid = identifier.trim() !== '' && !isIdentifierFilter(identifier);
  const filters = useMemo(
    () => ({
      status,
      primaryRole,
      identifier: identifierInvalid ? undefined : identifier,
      page: paging.page + 1,
      size: paging.pageSize,
    }),
    [status, primaryRole, identifier, identifierInvalid, paging],
  );
  const { data, isLoading, isFetching, error } = useAdminAccounts(filters);
  const resetPage = () => setPaging((p) => ({ ...p, page: 0 }));

  const columns: GridColDef<AdminAccount>[] = [
    { field: 'email', headerName: 'E-mail', flex: 1.2, minWidth: 200, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'phone', headerName: 'Phone', width: 150, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'primaryRole', headerName: 'Primary role', width: 180, valueFormatter: (v: string) => humanizeStatus(v) },
    {
      field: 'status',
      headerName: 'Status',
      width: 170,
      renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} />,
    },
    { field: 'createdAt', headerName: 'Created', width: 170, valueFormatter: (v: string) => formatDateTime(v) },
  ];

  return (
    <>
      <PageHeader portalName={portal.title} title="Accounts" subtitle="Platform accounts, their status and role assignments." />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="Exact phone or e-mail"
          value={identifier}
          error={identifierInvalid}
          helperText={identifierInvalid ? 'At least 3 characters.' : undefined}
          onChange={(e) => {
            setIdentifier(e.target.value);
            resetPage();
          }}
          sx={{ minWidth: 260 }}
        />
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as AccountStatus | 'all');
            resetPage();
          }}
          sx={{ minWidth: 190 }}
        >
          <MenuItem value="all">All statuses</MenuItem>
          {ACCOUNT_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {humanizeStatus(s)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Primary role"
          value={primaryRole}
          onChange={(e) => {
            setPrimaryRole(e.target.value as PrimaryRole | 'all');
            resetPage();
          }}
          sx={{ minWidth: 200 }}
        >
          <MenuItem value="all">All roles</MenuItem>
          {PRIMARY_ROLES.map((r) => (
            <MenuItem key={r} value={r}>
              {humanizeStatus(r)}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {accountErrorMessage(error, 'Accounts could not be loaded.')}
        </Alert>
      ) : null}

      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as AdminAccount).userId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as AdminAccount).userId)}
        emptyTitle="No accounts found"
        emptyDescription="Accounts matching your filters will appear here."
        server={{
          rowCount: data?.total ?? 0,
          paginationModel: paging,
          onPaginationModelChange: setPaging,
          pageSizeOptions: [...ACCOUNT_PAGE_SIZES],
        }}
      />

      <AccountDrawer userId={selected} onClose={() => setSelected(null)} />
    </>
  );
}
