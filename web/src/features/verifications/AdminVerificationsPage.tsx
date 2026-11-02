import { useMemo, useState } from 'react';
import { Alert, Box, Button, Divider, Drawer, IconButton, MenuItem, Skeleton, Stack, TextField, Typography } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { useVerification, useVerificationDecisions, useVerificationQueue } from '@/hooks/useAdminVerifications';
import {
  approvalProblem,
  formatAge,
  isValidRejectReason,
  MAX_LICENSE_NUMBER_LENGTH,
  MAX_REASON_LENGTH,
  MIN_REJECT_REASON_LENGTH,
  VERIFICATION_PAGE_SIZES,
  VERIFICATION_STATUSES,
  VERIFICATION_TYPES,
  verificationErrorMessage,
} from '@/services/adminVerifications.service';
import { humanizeStatus } from '@/services/adminAnalytics.service';
import { formatDate, formatDateTime } from '@/utils/format';
import type { VerificationDetail, VerificationQueueItem, VerificationStatus, VerificationType } from '@/types';

const shortId = (id: string | null) => (id ? `${id.slice(0, 8)}…` : '—');

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

function Decide({ request, onDone }: { request: VerificationDetail; onDone: () => void }) {
  const decisions = useVerificationDecisions(onDone);
  const [licenseNumber, setLicenseNumber] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [note, setNote] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const isLicence = request.type === 'PHARMACY_LICENSE';
  const input = { type: request.type, licenseNumber, expiresOn: expiresOn || undefined, reason: note };
  const problem = approvalProblem(input);
  const busy = decisions.approve.isPending || decisions.reject.isPending;

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">Approve</Typography>
      {isLicence ? (
        <>
          <Alert severity="info">
            Enter the licence number and expiry exactly as the document shows. Approval activates the organisation; the pharmacy
            is activated separately.
          </Alert>
          <TextField
            size="small"
            label="Licence number"
            value={licenseNumber}
            onChange={(e) => setLicenseNumber(e.target.value)}
            inputProps={{ maxLength: MAX_LICENSE_NUMBER_LENGTH }}
          />
        </>
      ) : null}
      <TextField
        size="small"
        type="date"
        label={isLicence ? 'Licence expiry' : 'Expiry (if the document has one)'}
        value={expiresOn}
        onChange={(e) => setExpiresOn(e.target.value)}
        InputLabelProps={{ shrink: true }}
      />
      <TextField
        size="small"
        label="Note (optional, audited)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        inputProps={{ maxLength: MAX_REASON_LENGTH }}
      />
      {problem && (licenseNumber || expiresOn || note) ? <Typography variant="caption" color="error">{problem}</Typography> : null}
      <Button
        variant="contained"
        color="success"
        disabled={!!problem || busy}
        onClick={() => decisions.approve.mutate({ id: request.requestId, input })}
      >
        Approve
      </Button>

      <Divider />
      <Typography variant="subtitle2">Reject</Typography>
      <TextField
        size="small"
        multiline
        minRows={2}
        label="Reason (shown to the applicant, audited)"
        value={rejectReason}
        onChange={(e) => setRejectReason(e.target.value)}
        helperText={`${MIN_REJECT_REASON_LENGTH}–${MAX_REASON_LENGTH} characters.`}
        inputProps={{ maxLength: MAX_REASON_LENGTH }}
      />
      <Button
        variant="outlined"
        color="error"
        disabled={!isValidRejectReason(rejectReason) || busy}
        onClick={() => decisions.reject.mutate({ id: request.requestId, reason: rejectReason })}
      >
        Reject
      </Button>
    </Stack>
  );
}

function ReviewDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const { data: request, isLoading, error } = useVerification(id);
  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 480 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">{request ? humanizeStatus(request.type) : 'Verification'}</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{verificationErrorMessage(error, 'The request could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={280} /> : null}
        {request ? (
          <Stack spacing={1.25}>
            <StatusChip status={request.status.toLowerCase()} />
            <Field label="Submitted" value={formatDateTime(request.submittedAt)} />
            {request.status === 'PENDING' ? <Field label="Waiting" value={formatAge(request.aging.ageSeconds)} /> : null}
            <Field label="Applicant" value={request.applicant ? `${humanizeStatus(request.applicant.primaryRole)} · ${request.applicant.accountStatus.toLowerCase()}` : shortId(request.userId)} />
            <Field label="Applicant id" value={request.userId} />
            <Field label="Organisation" value={request.organizationId ?? '—'} />
            {request.licenseNumber ? <Field label="Licence number" value={request.licenseNumber} /> : null}
            {request.expiresAt ? <Field label="Expires" value={formatDate(request.expiresAt)} /> : null}
            {request.rejectReason ? <Field label="Reject reason" value={request.rejectReason} /> : null}
            <Divider />
            <Typography variant="subtitle2">Documents ({request.documents.length})</Typography>
            <Alert severity="warning">
              Document preview is not available yet: the platform stores document references only. Review the originals through
              your document process.
            </Alert>
            {request.documents.map((d, i) => (
              <Field key={`${d.kind}-${i}`} label={humanizeStatus(d.kind)} value={d.expiresAt ? `expires ${formatDate(d.expiresAt)}` : 'reference on file'} />
            ))}
            <Divider />
            {request.status === 'PENDING' && can('verifications:manage') ? <Decide key={request.requestId} request={request} onDone={onClose} /> : null}
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * The verification queue (`GET /admin/verifications`, `verification:queue:read`), oldest pending
 * work visible by age, with approve and reject (`provider:verify:any`) in the review drawer.
 */
export function AdminVerificationsPage() {
  const portal = usePortal();
  const [status, setStatus] = useState<VerificationStatus | 'all'>('PENDING');
  const [type, setType] = useState<VerificationType | 'all'>('all');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: VERIFICATION_PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);

  const filters = useMemo(() => ({ status, type, page: paging.page + 1, size: paging.pageSize }), [status, type, paging]);
  const { data, isLoading, isFetching, error } = useVerificationQueue(filters);
  const resetPage = () => setPaging((p) => ({ ...p, page: 0 }));

  const columns: GridColDef<VerificationQueueItem>[] = [
    { field: 'type', headerName: 'Type', width: 170, valueFormatter: (v: string) => humanizeStatus(v) },
    { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} /> },
    { field: 'submittedAt', headerName: 'Submitted', width: 170, valueFormatter: (v: string) => formatDateTime(v) },
    {
      field: 'aging',
      headerName: 'Waiting',
      width: 100,
      sortable: false,
      valueGetter: (_v, row) => (row.status === 'PENDING' ? formatAge(row.aging.ageSeconds) : '—'),
    },
    { field: 'documentCount', headerName: 'Documents', width: 110, type: 'number' },
    { field: 'userId', headerName: 'Applicant', width: 120, valueFormatter: (v: string) => shortId(v) },
    { field: 'organizationId', headerName: 'Organisation', width: 130, valueFormatter: (v: string | null) => shortId(v) },
  ];

  return (
    <>
      <PageHeader portalName={portal.title} title="Verifications" subtitle="Review provider applications: licences, identity and documents." />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as VerificationStatus | 'all');
            resetPage();
          }}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="all">All statuses</MenuItem>
          {VERIFICATION_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {humanizeStatus(s)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Type"
          value={type}
          onChange={(e) => {
            setType(e.target.value as VerificationType | 'all');
            resetPage();
          }}
          sx={{ minWidth: 190 }}
        >
          <MenuItem value="all">All types</MenuItem>
          {VERIFICATION_TYPES.map((t) => (
            <MenuItem key={t} value={t}>
              {humanizeStatus(t)}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {verificationErrorMessage(error, 'The verification queue could not be loaded.')}
        </Alert>
      ) : null}

      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as VerificationQueueItem).requestId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as VerificationQueueItem).requestId)}
        emptyTitle="Nothing to review"
        emptyDescription="Verification requests matching your filters will appear here."
        server={{
          rowCount: data?.total ?? 0,
          paginationModel: paging,
          onPaginationModelChange: setPaging,
          pageSizeOptions: [...VERIFICATION_PAGE_SIZES],
        }}
      />

      <ReviewDrawer id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
