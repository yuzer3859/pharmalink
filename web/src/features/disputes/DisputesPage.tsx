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
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { usePortal } from '@/hooks/usePortal';
import { approvalErrorMessage } from '@/services/adminApprovals.service';
import { humanizeStatus } from '@/services/adminAnalytics.service';
import { parseBirr } from '@/services/adminRefund.service';
import {
  adminDisputesService,
  DISPUTE_CASE_STATUSES,
  DISPUTE_PRIORITIES,
  NEXT_STATUSES,
  RESOLVABLE,
  type DisputeCase,
  type DisputePriority,
  type DisputeStatus,
} from '@/services/adminDisputes.service';
import { formatDateTime } from '@/utils/format';

function CaseDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const notify = useNotify();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const [notes, setNotes] = useState('');
  const [action, setAction] = useState<'NO_ACTION' | 'REFUND'>('NO_ACTION');
  const [amount, setAmount] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-disputes-cases', 'detail', id] as const,
    queryFn: () => adminDisputesService.get(id as string),
    enabled: !!id,
  });
  const done = (message: string) => () => {
    qc.invalidateQueries({ queryKey: ['admin-disputes-cases'] });
    qc.invalidateQueries({ queryKey: ['admin-approvals'] });
    notify(message);
  };
  const failed = (fallback: string) => (e: unknown) => notify(approvalErrorMessage(e, fallback), 'error');
  const update = useMutation({
    mutationFn: (change: { status?: DisputeStatus; priority?: DisputePriority; assignToMe?: boolean }) => adminDisputesService.update(id!, change),
    onSuccess: done('Case updated.'),
    onError: failed('The case could not be updated.'),
  });
  const message = useMutation({
    mutationFn: () => adminDisputesService.message(id!, text, internal),
    onSuccess: () => {
      setText('');
      done(internal ? 'Internal note added.' : 'Reply sent to the customer.')();
    },
    onError: failed('The message could not be sent.'),
  });
  const parsed = amount.trim() === '' ? undefined : parseBirr(amount) ?? undefined;
  const resolve = useMutation({
    mutationFn: () => adminDisputesService.resolve(id!, { action, notes, amount: parsed }),
    onSuccess: (c) =>
      done(c.status === 'RESOLUTION_PENDING' ? 'Refund sent for approval; the case resolves when it is carried out.' : 'Case resolved.')(),
    onError: failed('The case could not be resolved.'),
  });
  const busy = update.isPending || message.isPending || resolve.isPending;

  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 540 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">Dispute {data?.caseNumber ?? ''}</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{approvalErrorMessage(error, 'The case could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={260} /> : null}
        {data ? (
          <Stack spacing={1.25}>
            <Stack direction="row" spacing={1} alignItems="center">
              <StatusChip status={data.status.toLowerCase()} />
              <Typography variant="body2">{humanizeStatus(data.type)} · {humanizeStatus(data.priority)}</Typography>
              {data.overdue ? <StatusChip status="critical" /> : null}
            </Stack>
            <Typography variant="subtitle1" fontWeight={700}>{data.subject}</Typography>
            <Typography variant="body2">{data.description}</Typography>
            <Typography variant="caption" color="text.secondary">
              Order {data.orderId} · opened {formatDateTime(data.openedAt)} · respond by {formatDateTime(data.slaDueAt)}
              {data.assignedAdminId ? ' · assigned' : ' · unassigned'}
            </Typography>
            {data.resolution ? (
              <Alert severity={data.status === 'RESOLUTION_PENDING' ? 'warning' : 'success'}>
                {data.status === 'RESOLUTION_PENDING' ? 'Waiting for a second finance officer to approve the refund. ' : 'Resolved: '}
                {humanizeStatus(String(data.resolution.action ?? ''))} — {String(data.resolution.notes ?? '')}
              </Alert>
            ) : null}

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button size="small" disabled={busy} onClick={() => update.mutate({ assignToMe: true })}>
                Assign to me
              </Button>
              {(NEXT_STATUSES[data.status] ?? []).map((s) => (
                <Button key={s} size="small" variant="outlined" disabled={busy} onClick={() => update.mutate({ status: s })}>
                  {humanizeStatus(s)}
                </Button>
              ))}
              <TextField
                select
                size="small"
                label="Priority"
                value={data.priority}
                onChange={(e) => update.mutate({ priority: e.target.value as DisputePriority })}
                sx={{ minWidth: 120 }}
              >
                {DISPUTE_PRIORITIES.map((p) => (
                  <MenuItem key={p} value={p}>
                    {humanizeStatus(p)}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>

            <Divider />
            <Typography variant="subtitle2">Thread</Typography>
            {data.messages.length === 0 ? <Typography variant="body2" color="text.secondary">No messages yet.</Typography> : null}
            {data.messages.map((m) => (
              <Box key={m.id} sx={{ p: 1, borderRadius: 1, bgcolor: m.internal ? 'warning.light' : 'action.hover', opacity: m.internal ? 0.9 : 1 }}>
                <Typography variant="caption" color="text.secondary">
                  {m.senderRole === 'CUSTOMER' ? 'Customer' : 'Support'}
                  {m.internal ? ' · internal note' : ''} · {formatDateTime(m.createdAt)}
                </Typography>
                <Typography variant="body2">{m.body}</Typography>
              </Box>
            ))}
            {data.status !== 'CLOSED' ? (
              <>
                <TextField size="small" multiline minRows={2} label="Message" value={text} onChange={(e) => setText(e.target.value)} inputProps={{ maxLength: 2000 }} />
                <Stack direction="row" spacing={1} alignItems="center">
                  <FormControlLabel control={<Switch checked={internal} onChange={(e) => setInternal(e.target.checked)} />} label="Internal note" />
                  <Button size="small" variant="contained" disabled={busy || !text.trim()} onClick={() => message.mutate()}>
                    {internal ? 'Add note' : 'Reply to customer'}
                  </Button>
                </Stack>
              </>
            ) : null}

            {RESOLVABLE.includes(data.status) ? (
              <>
                <Divider />
                <Typography variant="subtitle2">Resolve</Typography>
                <TextField select size="small" label="Outcome" value={action} onChange={(e) => setAction(e.target.value as 'NO_ACTION' | 'REFUND')}>
                  <MenuItem value="NO_ACTION">No remedy</MenuItem>
                  {can('finance:refund') ? <MenuItem value="REFUND">Refund the customer</MenuItem> : null}
                </TextField>
                {action === 'REFUND' ? (
                  <TextField size="small" label="Refund amount in birr (empty = everything refundable)" value={amount} onChange={(e) => setAmount(e.target.value)} />
                ) : null}
                <TextField size="small" multiline minRows={2} label="Resolution notes (audited)" value={notes} onChange={(e) => setNotes(e.target.value)} inputProps={{ maxLength: 2000 }} />
                <Button variant="contained" color="success" disabled={busy || notes.trim().length < 3 || (action === 'REFUND' && amount.trim() !== '' && parsed === undefined)} onClick={() => resolve.mutate()}>
                  Resolve
                </Button>
              </>
            ) : null}
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * Disputes (`/admin/disputes`, Work 86): customers' complaints about an order, its delivery or its
 * payment, worked to a recorded resolution (BRULE-50). Refund resolutions follow the refund rules.
 */
export function DisputesPage() {
  const portal = usePortal();
  const [status, setStatus] = useState<DisputeStatus | 'all'>('OPEN');
  const [overdue, setOverdue] = useState(false);
  const [mine, setMine] = useState(false);
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [selected, setSelected] = useState<string | null>(null);
  const filters = useMemo(() => ({ status, overdue, mine, page: paging.page + 1, size: paging.pageSize }), [status, overdue, mine, paging]);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-disputes-cases', filters] as const,
    queryFn: () => adminDisputesService.list(filters),
    placeholderData: keepPreviousData,
  });
  const reset = () => setPaging((p) => ({ ...p, page: 0 }));
  const columns: GridColDef<DisputeCase>[] = [
    { field: 'caseNumber', headerName: 'Case', width: 170 },
    { field: 'status', headerName: 'Status', width: 150, renderCell: ({ row }) => <StatusChip status={row.status.toLowerCase()} /> },
    { field: 'type', headerName: 'Topic', width: 110, valueGetter: (_v, row) => humanizeStatus(row.type) },
    { field: 'priority', headerName: 'Priority', width: 100, valueGetter: (_v, row) => humanizeStatus(row.priority) },
    { field: 'subject', headerName: 'Subject', flex: 1, minWidth: 200 },
    { field: 'slaDueAt', headerName: 'Respond by', width: 170, valueGetter: (_v, row) => `${formatDateTime(row.slaDueAt)}${row.overdue ? ' (overdue)' : ''}` },
  ];

  return (
    <>
      <PageHeader portalName={portal.title} title="Disputes" subtitle="Customer complaints about orders, deliveries and payments." />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
        <TextField select size="small" label="Status" value={status} onChange={(e) => { setStatus(e.target.value as DisputeStatus | 'all'); reset(); }} sx={{ minWidth: 180 }}>
          <MenuItem value="all">All</MenuItem>
          {DISPUTE_CASE_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {humanizeStatus(s)}
            </MenuItem>
          ))}
        </TextField>
        <FormControlLabel control={<Switch checked={overdue} onChange={(e) => { setOverdue(e.target.checked); reset(); }} />} label="Overdue only" />
        <FormControlLabel control={<Switch checked={mine} onChange={(e) => { setMine(e.target.checked); reset(); }} />} label="Assigned to me" />
      </Stack>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{approvalErrorMessage(error, 'Disputes could not be loaded.')}</Alert> : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as DisputeCase).id}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as DisputeCase).id)}
        emptyTitle="No disputes"
        emptyDescription="Cases matching your filters will appear here."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: [10, 25, 50] }}
      />
      <CaseDrawer key={selected ?? 'none'} id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
