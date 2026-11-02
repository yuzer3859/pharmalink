import { useMemo, useState } from 'react';
import { Alert, Box, Button, Divider, Drawer, Grid, IconButton, MenuItem, Skeleton, Stack, TextField, Typography } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { StatCard } from '@/components/common/StatCard';
import { usePortal } from '@/hooks/usePortal';
import { useCatalogDecision, useCatalogHistory, useCatalogReview, useCatalogSummary } from '@/hooks/useAdminCatalog';
import {
  availableActions,
  CATALOG_PAGE_SIZES,
  CATALOG_STATUSES,
  CATALOG_TYPES,
  catalogErrorMessage,
  isSearchFilter,
  isValidCatalogRejectReason,
  MAX_CATALOG_REJECT_REASON,
  MIN_CATALOG_REJECT_REASON,
  productName,
} from '@/services/adminCatalog.service';
import { formatAge } from '@/services/adminVerifications.service';
import { humanizeStatus } from '@/services/adminAnalytics.service';
import { fromMinorUnits } from '@/services/adminOrders.service';
import { currency, formatDateTime } from '@/utils/format';
import type { CatalogProductStatus, CatalogProductType, CatalogReviewItem } from '@/types';

const strength = (p: CatalogReviewItem) => (p.strengthValue !== null ? `${p.strengthValue}${p.strengthUnit ? ` ${p.strengthUnit}` : ''}` : null);

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

function ProductDrawer({ product, onClose }: { product: CatalogReviewItem | null; onClose: () => void }) {
  const history = useCatalogHistory(product?.id ?? null);
  const decide = useCatalogDecision(onClose);
  const [reason, setReason] = useState('');
  if (!product) return null;
  const actions = availableActions(product);

  return (
    <Drawer anchor="right" open onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 480 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">{productName(product)}</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Stack spacing={1.25} sx={{ p: 2 }}>
        <StatusChip status={product.status.toLowerCase()} />
        <Field label="Type" value={humanizeStatus(product.type)} />
        {product.genericName ? <Field label="Generic name" value={product.genericName} /> : null}
        {product.nameAm ? <Field label="Amharic name" value={product.nameAm} /> : null}
        {product.dosageForm ? <Field label="Dosage form" value={humanizeStatus(product.dosageForm)} /> : null}
        {strength(product) ? <Field label="Strength" value={strength(product) as string} /> : null}
        <Field label="Classification" value={product.rxClassification ?? '—'} />
        <Field label="Controlled schedule" value={humanizeStatus(product.controlledSchedule)} />
        <Field label="Online sale prohibited" value={product.onlineSaleProhibited ? 'Yes' : 'No'} />
        <Field label="Manufacturer" value={product.manufacturerName ?? '—'} />
        <Field label="Reference price" value={product.price !== null ? currency(fromMinorUnits(product.price)) : '—'} />

        {actions.length > 0 ? (
          <>
            <Divider />
            <Typography variant="subtitle2">Decision</Typography>
            <Stack direction="row" spacing={1}>
              {actions.includes('approve') ? (
                <Button variant="contained" color="success" disabled={decide.isPending} onClick={() => decide.mutate({ id: product.id, action: 'approve' })}>
                  Approve
                </Button>
              ) : null}
              {actions.includes('submit') ? (
                <Button variant="outlined" disabled={decide.isPending} onClick={() => decide.mutate({ id: product.id, action: 'submit' })}>
                  Submit for review
                </Button>
              ) : null}
              {actions.includes('resubmit') ? (
                <Button variant="outlined" disabled={decide.isPending} onClick={() => decide.mutate({ id: product.id, action: 'resubmit' })}>
                  Return to review
                </Button>
              ) : null}
            </Stack>
            {actions.includes('reject') ? (
              <Stack spacing={1}>
                <TextField
                  size="small"
                  multiline
                  minRows={2}
                  label="Rejection reason (audited)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  helperText={`${MIN_CATALOG_REJECT_REASON}–${MAX_CATALOG_REJECT_REASON} characters.`}
                  inputProps={{ maxLength: MAX_CATALOG_REJECT_REASON }}
                />
                <Button
                  variant="outlined"
                  color="error"
                  disabled={!isValidCatalogRejectReason(reason) || decide.isPending}
                  onClick={() => decide.mutate({ id: product.id, action: 'reject', reason })}
                >
                  Reject
                </Button>
              </Stack>
            ) : null}
          </>
        ) : null}

        <Divider />
        <Typography variant="subtitle2">Review history</Typography>
        {history.error ? <Alert severity="error">{catalogErrorMessage(history.error, 'History could not be loaded.')}</Alert> : null}
        {history.isLoading ? <Skeleton variant="rounded" height={80} /> : null}
        {history.data && history.data.history.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No recorded status changes.
          </Typography>
        ) : null}
        {history.data?.history.map((h, i) => (
          <Box key={`${h.occurredAt}-${i}`} sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
            <Typography variant="body2">
              {h.from ? humanizeStatus(h.from) : 'Created'} → {h.to ? humanizeStatus(h.to) : '—'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {formatDateTime(h.occurredAt)}
              {h.reason ? ` · ${h.reason}` : ''}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Drawer>
  );
}

/**
 * Catalogue moderation (`/admin/catalog/review`, `catalog:manage:any`): the review queue with its
 * summary, each product's details and history, and the decisions the server allows from its
 * current status (submit, approve, reject with a reason, return to review).
 */
export function CatalogReviewPage() {
  const portal = usePortal();
  const summary = useCatalogSummary();
  const [status, setStatus] = useState<CatalogProductStatus | 'all'>('PENDING_REVIEW');
  const [type, setType] = useState<CatalogProductType | 'all'>('all');
  const [q, setQ] = useState('');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: CATALOG_PAGE_SIZES[1] });
  const [selected, setSelected] = useState<CatalogReviewItem | null>(null);

  const qInvalid = q.trim() !== '' && !isSearchFilter(q);
  const filters = useMemo(
    () => ({ status, type, q: qInvalid ? undefined : q, page: paging.page + 1, size: paging.pageSize }),
    [status, type, q, qInvalid, paging],
  );
  const { data, isLoading, isFetching, error } = useCatalogReview(filters);
  const resetPage = () => setPaging((p) => ({ ...p, page: 0 }));

  const columns: GridColDef<CatalogReviewItem>[] = [
    { field: 'brandName', headerName: 'Product', flex: 1.3, minWidth: 200, valueGetter: (_v, row) => productName(row) },
    { field: 'type', headerName: 'Type', width: 140, valueFormatter: (v: string) => humanizeStatus(v) },
    { field: 'strengthValue', headerName: 'Strength', width: 110, sortable: false, valueGetter: (_v, row) => strength(row) ?? '—' },
    { field: 'rxClassification', headerName: 'Rx', width: 80, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'manufacturerName', headerName: 'Manufacturer', flex: 1, minWidth: 150, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'status', headerName: 'Status', width: 150, renderCell: ({ value }) => <StatusChip status={String(value).toLowerCase()} /> },
    { field: 'updatedAt', headerName: 'Updated', width: 170, valueFormatter: (v: string) => formatDateTime(v) },
  ];

  const s = summary.data;
  return (
    <>
      <PageHeader portalName={portal.title} title="Catalogue review" subtitle="Moderate catalogue products before customers can see them." />

      {s ? (
        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid item xs={12} sm={6} lg={3}>
            <StatCard label="Waiting for review" value={String(s.queue.pendingReviewCount)} />
          </Grid>
          <Grid item xs={12} sm={6} lg={3}>
            <StatCard label="Oldest waiting" value={s.queue.oldestPendingAgeSeconds !== null ? formatAge(s.queue.oldestPendingAgeSeconds) : '—'} />
          </Grid>
          <Grid item xs={12} sm={6} lg={3}>
            <StatCard label="Approved (all time)" value={String(s.lifetimeTransitions.approvals)} />
          </Grid>
          <Grid item xs={12} sm={6} lg={3}>
            <StatCard label="Rejected (all time)" value={String(s.lifetimeTransitions.rejections)} />
          </Grid>
        </Grid>
      ) : null}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="Search name"
          value={q}
          error={qInvalid}
          helperText={qInvalid ? 'At most 100 characters.' : undefined}
          onChange={(e) => {
            setQ(e.target.value);
            resetPage();
          }}
          sx={{ minWidth: 220 }}
        />
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as CatalogProductStatus | 'all');
            resetPage();
          }}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="all">All statuses</MenuItem>
          {CATALOG_STATUSES.map((v) => (
            <MenuItem key={v} value={v}>
              {humanizeStatus(v)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Type"
          value={type}
          onChange={(e) => {
            setType(e.target.value as CatalogProductType | 'all');
            resetPage();
          }}
          sx={{ minWidth: 170 }}
        >
          <MenuItem value="all">All types</MenuItem>
          {CATALOG_TYPES.map((v) => (
            <MenuItem key={v} value={v}>
              {humanizeStatus(v)}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {catalogErrorMessage(error, 'The catalogue could not be loaded.')}
        </Alert>
      ) : null}

      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected(row as CatalogReviewItem)}
        emptyTitle="Nothing to review"
        emptyDescription="Products matching your filters will appear here."
        server={{
          rowCount: data?.total ?? 0,
          paginationModel: paging,
          onPaginationModelChange: setPaging,
          pageSizeOptions: [...CATALOG_PAGE_SIZES],
        }}
      />

      <ProductDrawer key={selected?.id ?? 'none'} product={selected} onClose={() => setSelected(null)} />
    </>
  );
}
