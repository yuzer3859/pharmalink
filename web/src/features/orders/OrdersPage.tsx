import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { rxReviewErrorMessage, useFulfillmentAction, usePharmacyOrder, usePharmacyOrders, useRxReviewDecision } from '@/hooks/usePharmacyOrders';
import { usePortal } from '@/hooks/usePortal';
import { ApiError } from '@/services/apiClient';
import { fromMinorUnits } from '@/services/adminOrders.service';
import { prescriptionReviewService } from '@/services/prescriptionReview.service';
import {
  awaitingRxReview,
  DECLINE_REASON_MAX,
  declineReasonProblem,
  FULFILLMENT_STATUSES,
  nextActions,
  orderStageLabel,
  paymentLabel,
  PHARMACY_ORDER_PAGE_SIZES,
  REJECT_REASON_MAX,
  rejectReasonProblem,
  type FulfillmentStatus,
  type PharmacyOrder,
} from '@/services/pharmacyOrders.service';
import { currency, formatDateTime } from '@/utils/format';

const money = (minor: number, code: string) => currency(fromMinorUnits(minor), code);
const humanStatus = (status: string) => status.toLowerCase();

function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Your account is not allowed to view this pharmacy’s orders.';
  if (error instanceof ApiError && error.status === 404) return 'This order is no longer available to your pharmacy.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return 'Orders could not be loaded.';
}

function itemsSummary(order: PharmacyOrder): string {
  const units = order.lines.reduce((n, l) => n + l.quantity, 0);
  return `${order.lines.length} line${order.lines.length === 1 ? '' : 's'} · ${units} unit${units === 1 ? '' : 's'}`;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ textAlign: 'right' }}>
        {value}
      </Typography>
    </Stack>
  );
}

function PrescriptionSection({ f }: { f: PharmacyOrder }) {
  const { can } = useAuth();
  const notify = useNotify();
  const decision = useRxReviewDecision();
  const [legibilityOk, setLegibilityOk] = useState(false);
  const [validityOk, setValidityOk] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [opening, setOpening] = useState(false);
  const rx = f.prescription;
  const pharmacist = can('prescriptions:verify');
  const reviewable = awaitingRxReview(f) && pharmacist;
  const problem = rejectReasonProblem(reason);
  const busy = decision.isPending;

  async function openFile() {
    if (!rx) return;
    setOpening(true);
    try {
      const link = await prescriptionReviewService.filePreview(rx.id);
      window.open(link.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      notify(rxReviewErrorMessage(e), 'error');
    } finally {
      setOpening(false);
    }
  }

  if (!rx) {
    return f.requiresRx ? <Alert severity="warning">This order has prescription items but no prescription attached.</Alert> : null;
  }
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">Prescription</Typography>
      <Typography variant="body2" color="text.secondary">
        Uploaded {formatDateTime(rx.uploadedAt)} · {rx.fileType === 'application/pdf' ? 'PDF' : 'Photo'}
        {rx.doctorName ? ` · Dr ${rx.doctorName}` : ''}
        {rx.hospitalName ? ` · ${rx.hospitalName}` : ''}
      </Typography>
      {pharmacist ? (
        <>
          <Button variant="outlined" startIcon={<OpenInNewRoundedIcon />} disabled={opening} onClick={openFile}>
            {opening ? 'Opening…' : 'Open the prescription'}
          </Button>
          <Typography variant="caption" color="text.secondary">
            The link lasts a few minutes, and every opening is recorded.
          </Typography>
        </>
      ) : (
        <Alert severity="info">Only a pharmacist of your pharmacy can open and review the prescription.</Alert>
      )}
      {reviewable ? (
        rejecting ? (
          <Stack spacing={1}>
            <TextField
              size="small"
              multiline
              minRows={2}
              label="Why is it rejected? (the customer sees this)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              error={reason !== '' && !!problem}
              helperText={reason !== '' ? problem ?? ' ' : 'The order is cancelled and its stock released.'}
              inputProps={{ maxLength: REJECT_REASON_MAX }}
            />
            <Stack direction="row" spacing={1}>
              <Button
                variant="contained"
                color="error"
                disabled={busy || !!problem}
                onClick={() => decision.mutate({ id: f.id, kind: 'reject', reason })}
              >
                Reject prescription
              </Button>
              <Button disabled={busy} onClick={() => setRejecting(false)}>
                Back
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Stack spacing={0.5}>
            <Typography variant="body2">Check it covers what was ordered, as listed under “To prepare”.</Typography>
            <FormControlLabel control={<Checkbox checked={legibilityOk} onChange={(e) => setLegibilityOk(e.target.checked)} />} label="I could read it clearly" />
            <FormControlLabel control={<Checkbox checked={validityOk} onChange={(e) => setValidityOk(e.target.checked)} />} label="It is a valid prescription for these items" />
            <Stack direction="row" spacing={1}>
              <Button
                variant="contained"
                color="success"
                disabled={busy || !legibilityOk || !validityOk}
                onClick={() => decision.mutate({ id: f.id, kind: 'approve', legibilityOk, validityOk })}
              >
                Approve prescription
              </Button>
              <Button color="error" disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </Button>
            </Stack>
          </Stack>
        )
      ) : f.order.rxReviewStatus === 'APPROVED' ? (
        <Alert severity="success">Prescription approved. Preparing dispenses against it.</Alert>
      ) : f.order.rxReviewStatus === 'REJECTED' ? (
        <Alert severity="error">Prescription rejected. The order was cancelled.</Alert>
      ) : null}
    </Stack>
  );
}

function OrderDrawer({ fulfillmentId, onClose }: { fulfillmentId: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const { data: f, isLoading, error } = usePharmacyOrder(fulfillmentId);
  const action = useFulfillmentAction();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const reasonProblem = declineReasonProblem(reason);
  const actions = f && can('orders:manage') ? nextActions(f.status, f.order.rxReviewStatus) : [];
  const busy = action.isPending;
  const run = (name: 'accept' | 'prepare' | 'ready') => f && action.mutate({ id: f.id, action: name });

  return (
    <Drawer anchor="right" open={!!fulfillmentId} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 460 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">{f ? f.order.orderNumber : 'Order'}</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{loadErrorMessage(error)}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={260} /> : null}
        {f ? (
          <Stack spacing={1.25}>
            <Stack direction="row" spacing={1} alignItems="center">
              <StatusChip status={humanStatus(f.status)} />
              {awaitingRxReview(f) ? <Chip size="small" color="warning" label="Prescription to review" /> : f.requiresRx ? <Chip size="small" label="Prescription" /> : null}
            </Stack>
            <Typography variant="body2">{orderStageLabel(f)}</Typography>
            <Field label="Customer" value={f.customerName || 'Name not given'} />
            <Field label="Placed" value={f.order.placedAt ? formatDateTime(f.order.placedAt) : '—'} />
            <Field label="Payment" value={f.order.isCod ? 'Cash on delivery (the driver collects it)' : paymentLabel(f) === 'Paid' ? 'Paid online' : 'Online, not paid yet'} />
            <Field label="Order total" value={money(f.order.grandTotal, f.order.currency)} />
            {f.order.deliverySlot ? <Field label="Delivery slot" value={f.order.deliverySlot} /> : null}
            {f.acceptedAt ? <Field label="Accepted" value={formatDateTime(f.acceptedAt)} /> : null}
            {f.readyAt ? <Field label="Ready" value={formatDateTime(f.readyAt)} /> : null}

            <Divider />
            <Typography variant="subtitle2">To prepare</Typography>
            {f.lines.map((l) => (
              <Stack key={l.id} direction="row" justifyContent="space-between" spacing={2}>
                <Typography variant="body2">
                  {l.quantity} × {l.productName ?? 'Product'}
                  {l.requiresRx ? ' (Rx)' : ''}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {money(l.lineTotal, f.order.currency)}
                </Typography>
              </Stack>
            ))}
            {f.requiresRx || f.prescription ? (
              <>
                <Divider />
                <PrescriptionSection key={f.id} f={f} />
              </>
            ) : null}

            {actions.length > 0 ? (
              <>
                <Divider />
                {declining ? (
                  <Stack spacing={1}>
                    <TextField
                      size="small"
                      label="Why are you declining? (audited, shown to operations)"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      error={reason !== '' && !!reasonProblem}
                      helperText={reason !== '' ? reasonProblem ?? ' ' : 'For example: out of stock.'}
                      inputProps={{ maxLength: DECLINE_REASON_MAX }}
                      multiline
                      minRows={2}
                    />
                    <Stack direction="row" spacing={1}>
                      <Button
                        variant="contained"
                        color="error"
                        disabled={busy || !!reasonProblem}
                        onClick={() =>
                          action.mutate(
                            { id: f.id, action: 'decline', reason },
                            { onSuccess: () => { setDeclining(false); setReason(''); } },
                          )
                        }
                      >
                        Decline order
                      </Button>
                      <Button disabled={busy} onClick={() => setDeclining(false)}>
                        Back
                      </Button>
                    </Stack>
                  </Stack>
                ) : (
                  <Stack direction="row" spacing={1}>
                    {actions.includes('accept') ? (
                      <Button variant="contained" disabled={busy} onClick={() => run('accept')}>
                        Accept
                      </Button>
                    ) : null}
                    {actions.includes('decline') ? (
                      <Button color="error" disabled={busy} onClick={() => setDeclining(true)}>
                        Decline
                      </Button>
                    ) : null}
                    {actions.includes('prepare') ? (
                      <Button variant="contained" disabled={busy} onClick={() => run('prepare')}>
                        Start preparing
                      </Button>
                    ) : null}
                    {actions.includes('ready') ? (
                      <Button variant="contained" color="success" disabled={busy} onClick={() => run('ready')}>
                        Ready for pickup
                      </Button>
                    ) : null}
                  </Stack>
                )}
              </>
            ) : null}
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * Work 108: the pharmacy's orders on the real API. New orders first; the drawer shows what to
 * prepare and moves the order on. After "Ready for pickup" the order is the driver's, and its
 * status follows the delivery.
 */
export function OrdersPage() {
  const portal = usePortal();
  const [status, setStatus] = useState<FulfillmentStatus | 'all'>('all');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: PHARMACY_ORDER_PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);

  const filters = useMemo(() => ({ status, page: paging.page + 1, size: paging.pageSize }), [status, paging]);
  const { data, isLoading, isFetching, error } = usePharmacyOrders(filters);

  const columns: GridColDef<PharmacyOrder>[] = [
    { field: 'orderNumber', headerName: 'Order', flex: 1, minWidth: 170, valueGetter: (_v, row) => row.order.orderNumber },
    { field: 'customer', headerName: 'Customer', width: 170, valueGetter: (_v, row) => row.customerName || '—' },
    {
      field: 'status',
      headerName: 'Status',
      width: 140,
      renderCell: ({ value }) => <StatusChip status={humanStatus(String(value))} />,
    },
    { field: 'items', headerName: 'Items', width: 150, valueGetter: (_v, row) => itemsSummary(row) },
    { field: 'requiresRx', headerName: 'Prescription', width: 120, valueGetter: (_v, row) => (awaitingRxReview(row) ? 'To review' : row.requiresRx ? 'Yes' : '—') },
    { field: 'payment', headerName: 'Payment', width: 120, valueGetter: (_v, row) => paymentLabel(row) },
    { field: 'total', headerName: 'Total', width: 120, valueGetter: (_v, row) => money(row.order.grandTotal, row.order.currency) },
    {
      field: 'placedAt',
      headerName: 'Placed',
      width: 170,
      valueGetter: (_v, row) => (row.order.placedAt ? formatDateTime(row.order.placedAt) : '—'),
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Orders"
        subtitle="Review prescriptions, then accept, prepare and hand over your pharmacy’s orders. Only the customer’s name is shown, never their contact details."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as FulfillmentStatus | 'all');
            setPaging((p) => ({ ...p, page: 0 }));
          }}
          sx={{ minWidth: 200 }}
        >
          <MenuItem value="all">All statuses</MenuItem>
          {FULFILLMENT_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {humanStatus(s)}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadErrorMessage(error)}
        </Alert>
      ) : null}

      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as PharmacyOrder).id}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as PharmacyOrder).id)}
        emptyTitle="No orders"
        emptyDescription="Orders placed with your pharmacy appear here."
        server={{
          rowCount: data?.total ?? 0,
          paginationModel: paging,
          onPaginationModelChange: setPaging,
          pageSizeOptions: [...PHARMACY_ORDER_PAGE_SIZES],
        }}
      />

      <OrderDrawer fulfillmentId={selected} onClose={() => setSelected(null)} />
    </>
  );
}
