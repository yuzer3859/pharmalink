import { useMemo, useState } from 'react';
import { Alert, Box, Divider, Drawer, IconButton, MenuItem, Skeleton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { useAdminListing, useAdminListings } from '@/hooks/useAdminInventory';
import { usePortal } from '@/hooks/usePortal';
import { ADMIN_LISTING_PAGE_SIZES, isUuidFilter } from '@/services/adminInventory.service';
import { ApiError } from '@/services/apiClient';
import { formatDateTime } from '@/utils/format';
import type { AdminListing } from '@/types';

type Flag = 'any' | 'yes' | 'no';
const toFlag = (value: Flag) => (value === 'any' ? undefined : value === 'yes');
const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Your account is not allowed to view inventory operations.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return 'Inventory could not be loaded.';
}

function ShortId({ id }: { id: string }) {
  return (
    <Tooltip title={id}>
      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
        {id.slice(0, 8)}…
      </Typography>
    </Tooltip>
  );
}

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

function ListingDrawer({ listingId, onClose }: { listingId: string | null; onClose: () => void }) {
  const { data: listing, isLoading, error } = useAdminListing(listingId);
  return (
    <Drawer anchor="right" open={!!listingId} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 440 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">Listing</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{loadErrorMessage(error)}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={240} /> : null}
        {listing ? (
          <Stack spacing={1.25}>
            {!listing.storedMatchesComputed ? (
              <Alert severity="warning">Stored sellable stock differs from the stock computed from batches and reservations.</Alert>
            ) : null}
            <Field label="Listing" value={listing.listingId} />
            <Field label="Pharmacy" value={listing.pharmacyId} />
            <Field label="Branch" value={listing.branchId} />
            <Field label="Catalogue product" value={listing.catalogProductId} />
            <Divider />
            <Field label="Enabled" value={yesNo(listing.isEnabled)} />
            <Field label="Customer purchasable" value={yesNo(listing.customerPurchasable)} />
            <Field label="Sellable (stored)" value={String(listing.storedSellable)} />
            <Field label="Sellable (computed)" value={String(listing.computedSellable)} />
            <Field label="Reserved" value={String(listing.reserved)} />
            <Field label="Unexpired batches" value={`${listing.unexpiredBatchCount} (${listing.unexpiredBatchQuantity} units)`} />
            <Field label="Updated" value={formatDateTime(listing.updatedAt)} />
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * Platform-wide inventory listings for administrators (`GET /admin/operations/inventory/listings`,
 * `pharmacy:read:any`): read-only stock visibility, paged by the server. The pharmacy portal keeps
 * its own Inventory page.
 */
export function AdminInventoryPage() {
  const portal = usePortal();
  const [pharmacyId, setPharmacyId] = useState('');
  const [enabled, setEnabled] = useState<Flag>('any');
  const [purchasable, setPurchasable] = useState<Flag>('any');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: ADMIN_LISTING_PAGE_SIZES[1] });
  const [selected, setSelected] = useState<string | null>(null);

  const pharmacyInvalid = pharmacyId.trim() !== '' && !isUuidFilter(pharmacyId);
  const filters = useMemo(
    () => ({
      pharmacyId: pharmacyInvalid ? undefined : pharmacyId,
      isEnabled: toFlag(enabled),
      customerPurchasable: toFlag(purchasable),
      page: paging.page + 1,
      size: paging.pageSize,
    }),
    [pharmacyId, pharmacyInvalid, enabled, purchasable, paging],
  );
  const { data, isLoading, isFetching, error } = useAdminListings(filters);
  const resetPage = () => setPaging((p) => ({ ...p, page: 0 }));

  const columns: GridColDef<AdminListing>[] = [
    { field: 'listingId', headerName: 'Listing', width: 120, renderCell: ({ row }) => <ShortId id={row.listingId} /> },
    { field: 'pharmacyId', headerName: 'Pharmacy', width: 120, renderCell: ({ row }) => <ShortId id={row.pharmacyId} /> },
    { field: 'branchId', headerName: 'Branch', width: 120, renderCell: ({ row }) => <ShortId id={row.branchId} /> },
    { field: 'catalogProductId', headerName: 'Product', width: 120, renderCell: ({ row }) => <ShortId id={row.catalogProductId} /> },
    { field: 'isEnabled', headerName: 'Enabled', width: 90, valueFormatter: (v: boolean) => yesNo(v) },
    { field: 'storedSellable', headerName: 'Sellable (stored)', width: 140, type: 'number' },
    { field: 'computedSellable', headerName: 'Sellable (computed)', width: 160, type: 'number' },
    { field: 'customerPurchasable', headerName: 'Purchasable', width: 120, valueFormatter: (v: boolean) => yesNo(v) },
    { field: 'updatedAt', headerName: 'Updated', width: 170, valueFormatter: (v: string) => formatDateTime(v) },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Inventory"
        subtitle="Platform-wide listings and sellable stock. Read-only."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="Pharmacy id"
          value={pharmacyId}
          error={pharmacyInvalid}
          helperText={pharmacyInvalid ? 'Enter a full pharmacy id (UUID).' : undefined}
          onChange={(e) => {
            setPharmacyId(e.target.value);
            resetPage();
          }}
          sx={{ minWidth: 300 }}
        />
        <TextField
          select
          size="small"
          label="Enabled"
          value={enabled}
          onChange={(e) => {
            setEnabled(e.target.value as Flag);
            resetPage();
          }}
          sx={{ minWidth: 140 }}
        >
          <MenuItem value="any">Any</MenuItem>
          <MenuItem value="yes">Yes</MenuItem>
          <MenuItem value="no">No</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          label="Purchasable"
          value={purchasable}
          onChange={(e) => {
            setPurchasable(e.target.value as Flag);
            resetPage();
          }}
          sx={{ minWidth: 140 }}
        >
          <MenuItem value="any">Any</MenuItem>
          <MenuItem value="yes">Yes</MenuItem>
          <MenuItem value="no">No</MenuItem>
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
        getRowId={(row) => (row as AdminListing).listingId}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as AdminListing).listingId)}
        emptyTitle="No listings found"
        emptyDescription="Listings matching your filters will appear here."
        server={{
          rowCount: data?.total ?? 0,
          paginationModel: paging,
          onPaginationModelChange: setPaging,
          pageSizeOptions: [...ADMIN_LISTING_PAGE_SIZES],
        }}
      />

      <ListingDrawer listingId={selected} onClose={() => setSelected(null)} />
    </>
  );
}
