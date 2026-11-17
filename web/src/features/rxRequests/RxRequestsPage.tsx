import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { rxRequestErrorMessage, usePharmacyRxRequest, usePharmacyRxRequests, useRxRequestDecision } from '@/hooks/usePharmacyRxRequests';
import { usePortal } from '@/hooks/usePortal';
import { fromMinorUnits } from '@/services/adminOrders.service';
import { pharmacyInventoryService } from '@/services/pharmacyInventory.service';
import {
  pharmacyRxRequestsService,
  quoteProblem,
  reasonProblem,
  rxRequestActions,
  rxRequestStage,
  type PharmacyRxRequest,
  type QuoteInput,
} from '@/services/pharmacyRxRequests.service';
import { currency, formatDate, formatDateTime } from '@/utils/format';

const money = (minor: number, code: string) => currency(fromMinorUnits(minor), code);
const km = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
const PAGE_SIZES = [10, 25, 50];

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

type PaperChoice = 'auto' | 'yes' | 'no';

/** The holding pharmacist's quote: medicines from the branch's own stock, the date, the paper, the attestations. */
function QuoteForm({ r, busy, onSend }: { r: PharmacyRxRequest; busy: boolean; onSend: (q: QuoteInput) => void }) {
  const stock = useQuery({
    queryKey: ['pharmacy-rx-requests', 'stock', r.offer.branchId],
    queryFn: () => pharmacyInventoryService.list({ branchId: r.offer.branchId, size: 50 }),
  });
  const [lines, setLines] = useState<Array<{ catalogProductId: string; quantity: number }>>([]);
  const [adding, setAdding] = useState('');
  const [issueDate, setIssueDate] = useState(r.prescriptionIssueDate.slice(0, 10));
  const [paper, setPaper] = useState<PaperChoice>('auto');
  const [legibilityOk, setLegibilityOk] = useState(false);
  const [validityOk, setValidityOk] = useState(false);
  const [note, setNote] = useState('');

  const listings = (stock.data?.items ?? []).filter((l) => l.isEnabled && l.sellable > 0);
  const nameOf = (id: string) => listings.find((l) => l.catalogProductId === id)?.productName ?? 'Product';
  const sellableOf = (id: string) => listings.filter((l) => l.catalogProductId === id).reduce((n, l) => n + l.sellable, 0);
  const quote: QuoteInput = {
    lines,
    prescriptionIssueDate: issueDate,
    paperRequired: paper === 'auto' ? undefined : paper === 'yes',
    legibilityOk,
    validityOk,
    note,
  };
  const problem = quoteProblem(quote) ?? (lines.some((l) => l.quantity > sellableOf(l.catalogProductId)) ? 'A quantity is more than this branch can sell.' : null);

  return (
    <Stack spacing={1.25}>
      <Typography variant="subtitle2">Your quote</Typography>
      <Typography variant="body2" color="text.secondary">
        Add what your branch will give, from its stock. The customer sees the medicines and the total and confirms.
      </Typography>
      {stock.isLoading ? <Skeleton variant="rounded" height={56} /> : null}
      {stock.data && listings.length === 0 ? <Alert severity="warning">This branch has nothing in stock to quote.</Alert> : null}
      {lines.map((line, i) => (
        <Stack key={line.catalogProductId} direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" sx={{ flex: 1 }}>
            {nameOf(line.catalogProductId)}
            <Typography component="span" variant="caption" color="text.secondary">
              {' '}
              · {sellableOf(line.catalogProductId)} in stock
            </Typography>
          </Typography>
          <TextField
            size="small"
            type="number"
            label="Quantity"
            value={line.quantity}
            onChange={(e) => setLines((all) => all.map((l, j) => (j === i ? { ...l, quantity: Math.max(1, Math.floor(Number(e.target.value) || 1)) } : l)))}
            inputProps={{ min: 1 }}
            sx={{ width: 110 }}
          />
          <IconButton aria-label="Remove" onClick={() => setLines((all) => all.filter((_, j) => j !== i))}>
            <DeleteOutlineRoundedIcon />
          </IconButton>
        </Stack>
      ))}
      <TextField
        select
        size="small"
        label="Add a medicine"
        value={adding}
        onChange={(e) => {
          const id = e.target.value;
          if (id && !lines.some((l) => l.catalogProductId === id)) setLines((all) => [...all, { catalogProductId: id, quantity: 1 }]);
          setAdding('');
        }}
        disabled={listings.length === 0}
      >
        {[...new Map(listings.map((l) => [l.catalogProductId, l])).values()]
          .filter((l) => !lines.some((x) => x.catalogProductId === l.catalogProductId))
          .map((l) => (
            <MenuItem key={l.catalogProductId} value={l.catalogProductId}>
              {l.productName ?? 'Product'} · {money(l.price, l.currency)}
            </MenuItem>
          ))}
      </TextField>
      <TextField
        size="small"
        type="date"
        label="Date on the prescription"
        value={issueDate}
        onChange={(e) => setIssueDate(e.target.value)}
        InputLabelProps={{ shrink: true }}
        helperText="As you read it on the prescription. Old prescriptions are refused."
      />
      <Box>
        <Typography variant="body2" sx={{ mb: 0.5 }}>
          Original paper prescription
        </Typography>
        <ToggleButtonGroup size="small" exclusive value={paper} onChange={(_e, v: PaperChoice | null) => v && setPaper(v)} aria-label="Original paper prescription">
          <ToggleButton value="auto">By medicine</ToggleButton>
          <ToggleButton value="yes">Required</ToggleButton>
          <ToggleButton value="no">Not required</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
          {paper === 'auto'
            ? 'Required when a quoted medicine is a controlled substance.'
            : paper === 'yes'
              ? 'The driver collects the paper from the customer and brings it to you first.'
              : 'The customer keeps the paper.'}
        </Typography>
      </Box>
      <TextField size="small" label="Note to the customer (optional)" value={note} onChange={(e) => setNote(e.target.value)} inputProps={{ maxLength: 500 }} multiline minRows={2} />
      <FormControlLabel control={<Checkbox checked={legibilityOk} onChange={(e) => setLegibilityOk(e.target.checked)} />} label="I could read it clearly" />
      <FormControlLabel control={<Checkbox checked={validityOk} onChange={(e) => setValidityOk(e.target.checked)} />} label="It is a valid prescription for these medicines" />
      {problem && lines.length > 0 ? (
        <Typography variant="caption" color="text.secondary">
          {problem}
        </Typography>
      ) : null}
      <Button variant="contained" color="success" disabled={busy || !!problem} onClick={() => onSend(quote)}>
        Send the quote
      </Button>
    </Stack>
  );
}

function RequestDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const notify = useNotify();
  const { data: r, isLoading, error } = usePharmacyRxRequest(id);
  const decision = useRxRequestDecision();
  const [reasonFor, setReasonFor] = useState<'decline' | 'release' | null>(null);
  const [reason, setReason] = useState('');
  const [opening, setOpening] = useState(false);
  const pharmacist = can('prescriptions:verify');
  const actions = r && pharmacist ? rxRequestActions(r) : [];
  const busy = decision.isPending;
  const problem = reasonProblem(reason);

  useEffect(() => {
    setReasonFor(null);
    setReason('');
  }, [r?.id, r?.status]);

  async function openFile() {
    if (!r) return;
    setOpening(true);
    try {
      const link = await pharmacyRxRequestsService.fileLink(r.id);
      window.open(link.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      notify(rxRequestErrorMessage(e, 'The file could not be opened.'), 'error');
    } finally {
      setOpening(false);
    }
  }

  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 520 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">Prescription request</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{rxRequestErrorMessage(error, 'The request could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={300} /> : null}
        {r ? (
          <Stack spacing={1.25}>
            <StatusChip status={r.status.toLowerCase()} />
            <Typography variant="body2">{rxRequestStage(r)}</Typography>
            <Field label="Customer" value={r.customerName || 'Name not given'} />
            <Field label="Distance from your branch" value={km(r.offer.distanceMeters)} />
            <Field label="Received" value={formatDateTime(r.createdAt)} />
            <Field label="Date on the prescription (customer)" value={formatDate(r.prescriptionIssueDate)} />
            {r.status === 'OPEN' ? <Field label="Open for accepting until" value={formatDateTime(r.expiresAt)} /> : null}
            {r.claimExpiresAt ? <Field label="Send your quote before" value={formatDateTime(r.claimExpiresAt)} /> : null}
            {r.note ? <Alert severity="info">Customer’s note: {r.note}</Alert> : null}

            {pharmacist && (r.offer.status === 'OPEN' || r.offer.status === 'WON') ? (
              <>
                <Button variant="outlined" startIcon={<OpenInNewRoundedIcon />} disabled={opening} onClick={openFile}>
                  {opening ? 'Opening…' : 'Open the prescription'}
                </Button>
                <Typography variant="caption" color="text.secondary">
                  The link lasts a few minutes, and every opening is recorded.
                </Typography>
              </>
            ) : !pharmacist ? (
              <Alert severity="info">Only a pharmacist of your pharmacy can open the prescription and decide.</Alert>
            ) : null}

            {reasonFor ? (
              <Stack spacing={1}>
                <TextField
                  size="small"
                  multiline
                  minRows={2}
                  label={reasonFor === 'decline' ? 'Why can your pharmacy not fill it?' : 'Why are you letting it go?'}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  error={reason !== '' && !!problem}
                  helperText={reason !== '' ? problem ?? ' ' : 'For example: not in stock. Kept for operations.'}
                  inputProps={{ maxLength: 500 }}
                />
                <Stack direction="row" spacing={1}>
                  <Button variant="contained" color="error" disabled={busy || !!problem} onClick={() => decision.mutate({ id: r.id, kind: reasonFor, reason })}>
                    {reasonFor === 'decline' ? 'Decline' : 'Let it go'}
                  </Button>
                  <Button disabled={busy} onClick={() => setReasonFor(null)}>
                    Back
                  </Button>
                </Stack>
              </Stack>
            ) : actions.length > 0 ? (
              <Stack direction="row" spacing={1}>
                {actions.includes('accept') ? (
                  <Button variant="contained" disabled={busy} onClick={() => decision.mutate({ id: r.id, kind: 'accept' })}>
                    Accept
                  </Button>
                ) : null}
                {actions.includes('decline') ? (
                  <Button color="error" disabled={busy} onClick={() => setReasonFor('decline')}>
                    Decline
                  </Button>
                ) : null}
                {actions.includes('release') ? (
                  <Button color="error" disabled={busy} onClick={() => setReasonFor('release')}>
                    We cannot fill it
                  </Button>
                ) : null}
              </Stack>
            ) : null}

            {actions.includes('quote') && !reasonFor ? (
              <>
                <Divider />
                <QuoteForm r={r} busy={busy} onSend={(quote) => decision.mutate({ id: r.id, kind: 'quote', quote })} />
              </>
            ) : null}

            {r.quote ? (
              <>
                <Divider />
                <Typography variant="subtitle2">Quote sent</Typography>
                {r.quote.lines.map((l) => (
                  <Stack key={l.catalogProductId} direction="row" justifyContent="space-between">
                    <Typography variant="body2">
                      {l.quantity} × {l.name || 'Product'}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {money(l.lineTotal, r.quote!.currency)}
                    </Typography>
                  </Stack>
                ))}
                <Field label="Delivery" value={money(r.quote.deliveryFee, r.quote.currency)} />
                <Field label="Total" value={money(r.quote.grandTotal, r.quote.currency)} />
                <Field label="Original paper" value={r.quote.paperRequired ? 'Required: the driver brings it to you first' : 'Not required'} />
                {r.quoteExpiresAt && r.status === 'QUOTED' ? <Field label="Customer answers by" value={formatDateTime(r.quoteExpiresAt)} /> : null}
                {r.orderId ? <Alert severity="success">The customer confirmed. It is now an order under Orders.</Alert> : null}
              </>
            ) : null}
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * Work 137 (owner decision 2026-11-17): prescription requests offered to this pharmacy. The first
 * pharmacist to accept owns one; the others see it taken. Refreshed every few seconds.
 */
export function RxRequestsPage() {
  const portal = usePortal();
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, isFetching, error } = usePharmacyRxRequests(scope, paging.page + 1, paging.pageSize);

  const columns: GridColDef<PharmacyRxRequest>[] = useMemo(
    () => [
      { field: 'createdAt', headerName: 'Received', width: 170, valueFormatter: (v: string) => formatDateTime(v) },
      { field: 'customerName', headerName: 'Customer', flex: 1, minWidth: 160, valueGetter: (_v, row) => row.customerName || '—' },
      { field: 'stage', headerName: 'Where it is', flex: 1.4, minWidth: 220, valueGetter: (_v, row) => rxRequestStage(row) },
      { field: 'distance', headerName: 'Distance', width: 110, valueGetter: (_v, row) => km(row.offer.distanceMeters) },
      {
        field: 'due',
        headerName: 'Until',
        width: 170,
        valueGetter: (_v, row) => (row.status === 'OPEN' ? formatDateTime(row.expiresAt) : row.claimExpiresAt ? formatDateTime(row.claimExpiresAt) : '—'),
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Prescription requests"
        subtitle="Customers nearby who sent a prescription. The first pharmacy to accept gets it; send the medicines and price, and the customer confirms."
      />
      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
        <TextField select size="small" label="Show" value={scope} onChange={(e) => setScope(e.target.value as 'active' | 'all')} sx={{ minWidth: 220 }}>
          <MenuItem value="active">Open to you, or yours</MenuItem>
          <MenuItem value="all">All, with history</MenuItem>
        </TextField>
      </Stack>
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {rxRequestErrorMessage(error, 'Requests could not be loaded.')}
        </Alert>
      ) : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as PharmacyRxRequest).id}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as PharmacyRxRequest).id)}
        emptyTitle="No requests"
        emptyDescription="Prescription requests from customers near your branches appear here."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: PAGE_SIZES }}
      />
      <RequestDrawer id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
