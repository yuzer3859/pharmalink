import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useNotify } from '@/context/NotificationContext';
import { reviewErrorMessage, useReviewDecision, useReviewPrescription, useReviewQueue } from '@/hooks/usePrescriptionReview';
import { usePortal } from '@/hooks/usePortal';
import {
  approvalProblem,
  NOTE_MAX,
  noteProblem,
  prescriptionReviewService,
  type ApprovalLine,
  type ReviewPrescription,
} from '@/services/prescriptionReview.service';
import { formatDate, formatDateTime } from '@/utils/format';

const PAGE_SIZES = [10, 25, 50];

const requestedSummary = (p: ReviewPrescription) =>
  p.requestedItems?.length ? p.requestedItems.map((i) => `${i.quantity} × ${i.productName ?? 'product'}`).join(', ') : '—';

type Mode = 'approve' | 'reject' | 'clarify';

function ReviewDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const notify = useNotify();
  const { data: rx, isLoading, error } = useReviewPrescription(id);
  const decision = useReviewDecision();
  const [mode, setMode] = useState<Mode>('approve');
  const [lines, setLines] = useState<ApprovalLine[]>([]);
  const [legibilityOk, setLegibilityOk] = useState(false);
  const [validityOk, setValidityOk] = useState(false);
  const [note, setNote] = useState('');
  const [opening, setOpening] = useState(false);

  // A fresh form for each prescription: what the customer asked for, nothing attested yet.
  useEffect(() => {
    setMode('approve');
    setLines((rx?.requestedItems ?? []).map((i) => ({ catalogProductId: i.catalogProductId, approvedQuantity: i.quantity, refillsAllowed: 0, isSingleUse: false })));
    setLegibilityOk(false);
    setValidityOk(false);
    setNote('');
  }, [rx?.id, rx?.requestedItems]);

  const approval = { lines: lines.filter((l) => l.approvedQuantity > 0), legibilityOk, validityOk };
  const approveProblem = approvalProblem(approval);
  const notesProblem = noteProblem(note);
  const reviewable = rx?.status === 'PENDING_VERIFICATION';
  const busy = decision.isPending;
  const setLine = (index: number, patch: Partial<ApprovalLine>) =>
    setLines((all) => all.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const done = () => onClose();

  async function openFile() {
    if (!rx) return;
    setOpening(true);
    try {
      const link = await prescriptionReviewService.filePreview(rx.id);
      window.open(link.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      notify(reviewErrorMessage(e, 'The file could not be opened.'), 'error');
    } finally {
      setOpening(false);
    }
  }

  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 500 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">Prescription review</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{reviewErrorMessage(error, 'The prescription could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={300} /> : null}
        {rx ? (
          <Stack spacing={1.5}>
            <StatusChip status={(rx.displayStatus ?? rx.status).toLowerCase()} />
            <Typography variant="body2" color="text.secondary">
              Received {formatDateTime(rx.createdAt)}
              {rx.doctorName ? ` · Dr ${rx.doctorName}` : ''}
              {rx.hospitalName ? ` · ${rx.hospitalName}` : ''}
              {rx.issueDate ? ` · issued ${formatDate(rx.issueDate)}` : ''}
              {rx.expiryDate ? ` · expires ${formatDate(rx.expiryDate)}` : ''}
            </Typography>
            <Button variant="outlined" startIcon={<OpenInNewRoundedIcon />} disabled={opening} onClick={openFile}>
              {opening ? 'Opening…' : 'Open the prescription file'}
            </Button>
            <Typography variant="caption" color="text.secondary">
              The link lasts a few minutes, and every opening is recorded.
            </Typography>

            <Divider />
            <Typography variant="subtitle2">What the customer asks for</Typography>
            {lines.length === 0 ? (
              <Alert severity="info">
                No items were requested through checkout for this prescription. Ask the customer to open checkout again, or ask for clarification.
              </Alert>
            ) : null}

            {reviewable ? (
              <>
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant={mode === 'approve' ? 'contained' : 'text'} onClick={() => setMode('approve')}>Approve</Button>
                  <Button size="small" variant={mode === 'clarify' ? 'contained' : 'text'} onClick={() => setMode('clarify')}>Ask for clarification</Button>
                  <Button size="small" color="error" variant={mode === 'reject' ? 'contained' : 'text'} onClick={() => setMode('reject')}>Reject</Button>
                </Stack>

                {mode === 'approve' ? (
                  <Stack spacing={1.25}>
                    {lines.map((line, index) => {
                      const item = rx.requestedItems?.[index];
                      return (
                        <Box key={line.catalogProductId} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
                          <Typography variant="body2" sx={{ mb: 1 }}>
                            {item?.productName ?? 'Product'} · asked for {item?.quantity ?? '—'}
                          </Typography>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <TextField
                              size="small"
                              type="number"
                              label="Approve quantity"
                              value={line.approvedQuantity}
                              onChange={(e) => setLine(index, { approvedQuantity: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                              inputProps={{ min: 0 }}
                              helperText="0 leaves it out"
                              sx={{ width: 150 }}
                            />
                            <TextField
                              size="small"
                              type="number"
                              label="Refills"
                              value={line.refillsAllowed}
                              onChange={(e) => setLine(index, { refillsAllowed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                              inputProps={{ min: 0 }}
                              sx={{ width: 100 }}
                            />
                            <FormControlLabel
                              control={<Switch checked={line.isSingleUse} onChange={(e) => setLine(index, { isSingleUse: e.target.checked })} />}
                              label="Single use"
                            />
                          </Stack>
                        </Box>
                      );
                    })}
                    <FormControlLabel control={<Checkbox checked={legibilityOk} onChange={(e) => setLegibilityOk(e.target.checked)} />} label="I could read it clearly" />
                    <FormControlLabel control={<Checkbox checked={validityOk} onChange={(e) => setValidityOk(e.target.checked)} />} label="It is a valid prescription for these items" />
                    {approveProblem && lines.length > 0 ? <Typography variant="caption" color="text.secondary">{approveProblem}</Typography> : null}
                    <Button
                      variant="contained"
                      color="success"
                      disabled={busy || !!approveProblem}
                      onClick={() => decision.mutate({ id: rx.id, kind: 'approve', approval }, { onSuccess: done })}
                    >
                      Approve prescription
                    </Button>
                  </Stack>
                ) : (
                  <Stack spacing={1}>
                    <TextField
                      size="small"
                      multiline
                      minRows={2}
                      label={mode === 'reject' ? 'Why is it rejected? (the customer sees this)' : 'What should the customer clarify?'}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      error={note !== '' && !!notesProblem}
                      helperText={note !== '' ? notesProblem ?? ' ' : ' '}
                      inputProps={{ maxLength: NOTE_MAX }}
                    />
                    <Button
                      variant="contained"
                      color={mode === 'reject' ? 'error' : 'primary'}
                      disabled={busy || !!notesProblem}
                      onClick={() =>
                        decision.mutate(
                          mode === 'reject' ? { id: rx.id, kind: 'reject', reason: note } : { id: rx.id, kind: 'clarify', message: note },
                          { onSuccess: done },
                        )
                      }
                    >
                      {mode === 'reject' ? 'Reject prescription' : 'Send the request'}
                    </Button>
                  </Stack>
                )}
              </>
            ) : (
              <Alert severity="info">This prescription is no longer waiting for review.</Alert>
            )}
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * Work 110: prescriptions sent to this pharmacy for review. Checkout routes a customer's
 * prescription to the pharmacy it matched (Work 109); the pharmacist approves the items the
 * customer asked for, asks for clarification, or rejects it. Approval lets the customer pay and
 * order from this pharmacy.
 */
export function PrescriptionsPage() {
  const portal = usePortal();
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, isFetching, error } = useReviewQueue(paging.page + 1, paging.pageSize);

  const columns: GridColDef<ReviewPrescription>[] = [
    { field: 'createdAt', headerName: 'Received', width: 170, valueFormatter: (v: string) => formatDateTime(v) },
    { field: 'requested', headerName: 'Asked for', flex: 1, minWidth: 220, valueGetter: (_v, row) => requestedSummary(row) },
    { field: 'doctorName', headerName: 'Doctor', width: 150, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'fileType', headerName: 'File', width: 130, valueFormatter: (v: string | null) => (v === 'application/pdf' ? 'PDF' : v ? 'Photo' : '—') },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Prescriptions"
        subtitle="Prescriptions sent to your pharmacy for review. Approve the items before the customer can pay."
      />
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {reviewErrorMessage(error, 'The review queue could not be loaded.')}
        </Alert>
      ) : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as ReviewPrescription).id}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as ReviewPrescription).id)}
        emptyTitle="Nothing to review"
        emptyDescription="Prescriptions appear here when a customer opens checkout with a prescription medicine your pharmacy can supply."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: PAGE_SIZES }}
      />
      <ReviewDrawer id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
