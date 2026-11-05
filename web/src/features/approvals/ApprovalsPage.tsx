import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useNotify } from '@/context/NotificationContext';
import { usePortal } from '@/hooks/usePortal';
import {
  adminApprovalsService,
  APPROVAL_PAGE_SIZES,
  APPROVAL_STATUSES,
  approvalErrorMessage,
  MAX_APPROVAL_REASON_LENGTH,
} from '@/services/adminApprovals.service';
import { humanizeStatus } from '@/services/adminAnalytics.service';
import { formatDateTime } from '@/utils/format';
import type { Approval, ApprovalDecision, ApprovalStatus } from '@/types';

const shortId = (id: string) => `${id.slice(0, 8)}…`;

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ textAlign: 'right', wordBreak: 'break-all' }}>
        {value}
      </Typography>
    </Stack>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <Box
      component="pre"
      sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre-wrap' }}
    >
      {JSON.stringify(value, null, 2)}
    </Box>
  );
}

/** One request: what will run, who asked, and — for a permitted checker — approve or reject. */
export function ApprovalDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const notify = useNotify();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-approvals', 'detail', id] as const,
    queryFn: () => adminApprovalsService.get(id as string),
    enabled: !!id,
  });
  const decide = useMutation({
    mutationFn: (decision: ApprovalDecision) => adminApprovalsService.decide(id as string, decision, reason),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['admin-approvals'] });
      notify(result.status === 'REJECTED' ? 'Request rejected.' : 'Request approved and carried out.');
      onClose();
    },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['admin-approvals'] });
      notify(approvalErrorMessage(e, 'The request could not be decided.'), 'error');
    },
  });
  const reasonMissing = reason.trim() === '';

  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 520 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">Approval request</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{approvalErrorMessage(error, 'The request could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={260} /> : null}
        {data ? (
          <Stack spacing={1.25}>
            <StatusChip status={data.status.toLowerCase()} />
            <Typography variant="subtitle1" fontWeight={700}>
              {data.summary}
            </Typography>
            <Field label="Action" value={humanizeStatus(data.actionType)} />
            <Field label="Target" value={`${humanizeStatus(data.entityType)} · ${data.entityId}`} />
            <Field label="Requested by" value={data.isOwnRequest ? 'You' : data.requestedByUserId} />
            {data.reason ? <Field label="Reason" value={data.reason} /> : null}
            <Field label="Requested" value={formatDateTime(data.createdAt)} />
            <Field label="Expires" value={formatDateTime(data.expiresAt)} />
            <Field label="Checker needs" value={data.requiredPermission} />
            {data.decidedAt ? (
              <>
                <Field label="Decided" value={formatDateTime(data.decidedAt)} />
                <Field label="Decided by" value={data.decidedByUserId ?? '—'} />
                {data.decisionNote ? <Field label="Note" value={data.decisionNote} /> : null}
              </>
            ) : null}
            <Divider />
            <Typography variant="subtitle2">What will run</Typography>
            <Json value={data.payload} />
            {data.executedAt ? (
              <>
                <Typography variant="subtitle2">Outcome ({formatDateTime(data.executedAt)})</Typography>
                <Json value={data.executionResult} />
              </>
            ) : null}
            {data.executionError ? (
              <Alert severity="error">
                The action could not be carried out: {data.executionError.message} ({data.executionError.code})
              </Alert>
            ) : null}
            {data.status === 'APPROVED' && !data.executedAt ? (
              <Alert severity="warning">Approved but not yet carried out. Approving again resumes it safely.</Alert>
            ) : null}

            {data.isOwnRequest && data.status === 'PENDING' ? (
              <Alert severity="info">You made this request. A different administrator must decide it.</Alert>
            ) : null}
            {data.canDecide ? (
              <>
                <Divider />
                <TextField
                  size="small"
                  multiline
                  minRows={2}
                  label="Reason (required to reject, audited)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  inputProps={{ maxLength: MAX_APPROVAL_REASON_LENGTH }}
                />
                <Stack direction="row" spacing={1}>
                  <Button variant="contained" color="success" disabled={decide.isPending} onClick={() => decide.mutate('APPROVE')}>
                    Approve
                  </Button>
                  <Button
                    variant="outlined"
                    color="error"
                    disabled={decide.isPending || reasonMissing}
                    onClick={() => decide.mutate('REJECT')}
                  >
                    Reject
                  </Button>
                </Stack>
              </>
            ) : null}
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * Pending approvals (`/admin/approvals`, Work 82): sensitive actions waiting for a second
 * administrator. Anyone with `approval:read:any` sees the queue; the server decides who may approve
 * each request (never its maker; only a holder of the action's own permission).
 */
export function ApprovalsPage() {
  const portal = usePortal();
  const [status, setStatus] = useState<ApprovalStatus | 'all'>('PENDING');
  const [mine, setMine] = useState(false);
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: APPROVAL_PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);
  const filters = useMemo(() => ({ status, mine, page: paging.page + 1, size: paging.pageSize }), [status, mine, paging]);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-approvals', filters] as const,
    queryFn: () => adminApprovalsService.list(filters),
    placeholderData: keepPreviousData,
  });
  const actions = useQuery({ queryKey: ['admin-approvals', 'actions'] as const, queryFn: () => adminApprovalsService.actions() });
  const guarded = (actions.data?.items ?? []).filter((a) => a.requiresApproval);
  const reset = () => setPaging((p) => ({ ...p, page: 0 }));

  const columns: GridColDef<Approval>[] = [
    { field: 'createdAt', headerName: 'Requested', width: 170, valueGetter: (_v, row) => formatDateTime(row.createdAt) },
    { field: 'status', headerName: 'Status', width: 120, renderCell: ({ row }) => <StatusChip status={row.status.toLowerCase()} /> },
    { field: 'actionType', headerName: 'Action', width: 180, valueGetter: (_v, row) => humanizeStatus(row.actionType) },
    { field: 'summary', headerName: 'Summary', flex: 1, minWidth: 220 },
    { field: 'maker', headerName: 'Requested by', width: 130, valueGetter: (_v, row) => (row.isOwnRequest ? 'You' : shortId(row.requestedByUserId)) },
    { field: 'expiresAt', headerName: 'Expires', width: 170, valueGetter: (_v, row) => formatDateTime(row.expiresAt) },
    { field: 'canDecide', headerName: 'Your turn', width: 100, valueGetter: (_v, row) => (row.canDecide ? 'Yes' : '') },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Pending approvals"
        subtitle="Sensitive actions that need a second administrator (maker-checker)."
      />
      {actions.data ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          {guarded.length > 0
            ? `Actions that need a second administrator: ${guarded.map((a) => humanizeStatus(a.type)).join(', ')}.`
            : 'No action currently needs a second administrator.'}
        </Alert>
      ) : null}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as ApprovalStatus | 'all');
            reset();
          }}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="all">All</MenuItem>
          {APPROVAL_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {humanizeStatus(s)}
            </MenuItem>
          ))}
        </TextField>
        <FormControlLabel
          control={
            <Switch
              checked={mine}
              onChange={(e) => {
                setMine(e.target.checked);
                reset();
              }}
            />
          }
          label="Only my requests"
        />
      </Stack>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{approvalErrorMessage(error, 'Requests could not be loaded.')}</Alert> : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as Approval).id}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as Approval).id)}
        emptyTitle="No requests"
        emptyDescription="Requests matching your filters will appear here."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: [...APPROVAL_PAGE_SIZES] }}
      />
      <ApprovalDrawer key={selected ?? 'none'} id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
