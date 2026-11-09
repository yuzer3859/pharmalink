import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import {
  inventoryErrorMessage,
  useBranches,
  useInventoryActions,
  useListing,
  useListings,
  useMovements,
  useProductSearch,
} from '@/hooks/usePharmacyInventory';
import { fromMinorUnits } from '@/services/adminOrders.service';
import {
  adjustmentProblem,
  batchProblem,
  newListingProblem,
  productLabel,
  stockLevel,
  type Branch,
  type CatalogHit,
  type InventoryBatch,
  type InventoryListing,
} from '@/services/pharmacyInventory.service';
import { currency, formatDate, formatDateTime } from '@/utils/format';

const PAGE_SIZES = [10, 25, 50];
const money = (minor: number, code: string) => currency(fromMinorUnits(minor), code);
const LEVEL_LABEL = { out_of_stock: 'out of stock', low_stock: 'low stock', in_stock: 'in stock', disabled: 'disabled' } as const;
const today = () => new Date().toISOString().slice(0, 10);

function AddListingDialog({ branches, onClose }: { branches: Branch[]; onClose: () => void }) {
  const actions = useInventoryActions();
  const [query, setQuery] = useState('');
  const [product, setProduct] = useState<CatalogHit | null>(null);
  const [form, setForm] = useState({ branchId: branches[0]?.id ?? '', price: '', batchNumber: '', quantity: '', expiryDate: '', supplier: '' });
  const search = useProductSearch(query);
  const input = {
    catalogProductId: product?.id ?? '',
    branchId: form.branchId,
    priceBirr: Number(form.price),
    batchNumber: form.batchNumber,
    initialQuantity: Number(form.quantity),
    expiryDate: form.expiryDate,
    supplier: form.supplier,
  };
  const problem = newListingProblem(input);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>List a product</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Autocomplete
            options={search.data?.items ?? []}
            getOptionLabel={productLabel}
            filterOptions={(o) => o}
            value={product}
            onChange={(_e, v) => setProduct(v)}
            onInputChange={(_e, v) => setQuery(v)}
            loading={search.isFetching}
            noOptionsText={query.trim().length < 2 ? 'Type at least 2 letters' : 'No catalogue product matches'}
            renderInput={(params) => <TextField {...params} size="small" label="Catalogue product" />}
          />
          <TextField select size="small" label="Branch" value={form.branchId} onChange={set('branchId')} disabled={branches.length === 0}>
            {branches.map((b) => (
              <MenuItem key={b.id} value={b.id}>
                {b.name}
              </MenuItem>
            ))}
          </TextField>
          {branches.length === 0 ? <Alert severity="info">Your account cannot see the pharmacy’s branches; ask the owner or a manager to list new products.</Alert> : null}
          <TextField size="small" type="number" label="Price per unit (birr)" value={form.price} onChange={set('price')} inputProps={{ min: 0, step: '0.01' }} />
          <Divider textAlign="left">First batch</Divider>
          <Stack direction="row" spacing={1}>
            <TextField size="small" label="Batch number" value={form.batchNumber} onChange={set('batchNumber')} sx={{ flex: 1 }} />
            <TextField size="small" type="number" label="Quantity" value={form.quantity} onChange={set('quantity')} inputProps={{ min: 1 }} sx={{ width: 120 }} />
          </Stack>
          <Stack direction="row" spacing={1}>
            <TextField size="small" type="date" label="Expiry" value={form.expiryDate} onChange={set('expiryDate')} InputLabelProps={{ shrink: true }} inputProps={{ min: today() }} sx={{ flex: 1 }} />
            <TextField size="small" label="Supplier (optional)" value={form.supplier} onChange={set('supplier')} sx={{ flex: 1 }} />
          </Stack>
          {problem && product ? <Typography variant="caption" color="text.secondary">{problem}</Typography> : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!!problem || actions.create.isPending} onClick={() => actions.create.mutate(input, { onSuccess: onClose })}>
          List product
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function BatchRow({ batch }: { batch: InventoryBatch }) {
  const actions = useInventoryActions();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const problem = adjustmentProblem(Number(delta), reason, batch.quantity);
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="body2">
          {batch.batchNumber} · {batch.quantity} unit{batch.quantity === 1 ? '' : 's'} · expires {formatDate(batch.expiryDate)}
        </Typography>
        <Button size="small" onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : 'Adjust'}
        </Button>
      </Stack>
      {open ? (
        <Stack spacing={1} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={1}>
            <TextField size="small" type="number" label="Change (− to remove)" value={delta} onChange={(e) => setDelta(e.target.value)} sx={{ width: 170 }} />
            <TextField size="small" label="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} inputProps={{ maxLength: 300 }} sx={{ flex: 1 }} />
          </Stack>
          {delta !== '' && problem ? <Typography variant="caption" color="text.secondary">{problem}</Typography> : null}
          <Button
            size="small"
            variant="contained"
            disabled={!!problem || actions.adjust.isPending}
            onClick={() =>
              actions.adjust.mutate(
                { batchId: batch.id, quantityDelta: Number(delta), reason },
                { onSuccess: () => { setOpen(false); setDelta(''); setReason(''); } },
              )
            }
          >
            Record adjustment
          </Button>
        </Stack>
      ) : null}
    </Box>
  );
}

function ListingDrawer({ id, branchName, onClose }: { id: string | null; branchName: (id: string) => string; onClose: () => void }) {
  const { can } = useAuth();
  const canManage = can('inventory:manage');
  const { data: listing, isLoading, error } = useListing(id);
  const movements = useMovements(id);
  const actions = useInventoryActions();
  const [price, setPrice] = useState('');
  const [batch, setBatch] = useState({ batchNumber: '', quantity: '', expiryDate: '', supplier: '' });
  const [confirmRemove, setConfirmRemove] = useState(false);

  // A fresh form per listing, and the saved price once it changes.
  const listingId = listing?.id;
  const savedPrice = listing?.price;
  useEffect(() => {
    setPrice(savedPrice === undefined ? '' : String(fromMinorUnits(savedPrice)));
    setBatch({ batchNumber: '', quantity: '', expiryDate: '', supplier: '' });
  }, [listingId, savedPrice]);

  const newBatch = { batchNumber: batch.batchNumber, quantity: Number(batch.quantity), expiryDate: batch.expiryDate, supplier: batch.supplier };
  const receiveProblem = batchProblem(newBatch);
  const priceChanged = listing && Number(price) > 0 && Math.round(Number(price) * 100) !== listing.price;

  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 520 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">{listing?.productName ?? 'Listing'}</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2 }}>
        {error ? <Alert severity="error">{inventoryErrorMessage(error, 'The listing could not be loaded.')}</Alert> : null}
        {isLoading ? <Skeleton variant="rounded" height={320} /> : null}
        {listing ? (
          <Stack spacing={1.5}>
            <StatusChip status={LEVEL_LABEL[stockLevel(listing)]} />
            <Typography variant="body2" color="text.secondary">
              {branchName(listing.branchId)} · {listing.onHand} on hand · {listing.reserved} reserved for orders · {listing.sellable} sellable
            </Typography>

            {canManage ? (
              <>
                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField size="small" type="number" label="Price (birr)" value={price} onChange={(e) => setPrice(e.target.value)} inputProps={{ min: 0, step: '0.01' }} sx={{ width: 150 }} />
                  <Button size="small" disabled={!priceChanged || actions.update.isPending} onClick={() => actions.update.mutate({ id: listing.id, patch: { priceBirr: Number(price) } })}>
                    Save price
                  </Button>
                  <FormControlLabel
                    sx={{ ml: 'auto' }}
                    control={<Switch checked={listing.isEnabled} disabled={actions.update.isPending} onChange={(e) => actions.update.mutate({ id: listing.id, patch: { isEnabled: e.target.checked } })} />}
                    label={listing.isEnabled ? 'Sold online' : 'Not sold'}
                  />
                </Stack>
              </>
            ) : (
              <Typography variant="body2">Price {money(listing.price, listing.currency)}</Typography>
            )}

            <Divider />
            <Typography variant="subtitle2">Batches (soonest expiry first)</Typography>
            {listing.batches.length === 0 ? <Typography variant="body2" color="text.secondary">No batches.</Typography> : null}
            {listing.batches.map((b) => (canManage ? <BatchRow key={b.id} batch={b} /> : (
              <Typography key={b.id} variant="body2">{b.batchNumber} · {b.quantity} · expires {formatDate(b.expiryDate)}</Typography>
            )))}

            {canManage ? (
              <>
                <Divider />
                <Typography variant="subtitle2">Receive stock</Typography>
                <Stack direction="row" spacing={1}>
                  <TextField size="small" label="Batch number" value={batch.batchNumber} onChange={(e) => setBatch((v) => ({ ...v, batchNumber: e.target.value }))} sx={{ flex: 1 }} />
                  <TextField size="small" type="number" label="Quantity" value={batch.quantity} onChange={(e) => setBatch((v) => ({ ...v, quantity: e.target.value }))} inputProps={{ min: 1 }} sx={{ width: 110 }} />
                </Stack>
                <Stack direction="row" spacing={1}>
                  <TextField size="small" type="date" label="Expiry" value={batch.expiryDate} onChange={(e) => setBatch((v) => ({ ...v, expiryDate: e.target.value }))} InputLabelProps={{ shrink: true }} inputProps={{ min: today() }} sx={{ flex: 1 }} />
                  <TextField size="small" label="Supplier (optional)" value={batch.supplier} onChange={(e) => setBatch((v) => ({ ...v, supplier: e.target.value }))} sx={{ flex: 1 }} />
                </Stack>
                <Button
                  variant="contained"
                  disabled={!!receiveProblem || actions.receive.isPending}
                  onClick={() => actions.receive.mutate({ id: listing.id, batch: newBatch }, { onSuccess: () => setBatch({ batchNumber: '', quantity: '', expiryDate: '', supplier: '' }) })}
                >
                  Receive
                </Button>
              </>
            ) : null}

            <Divider />
            <Typography variant="subtitle2">Recent stock movements</Typography>
            {(movements.data?.items ?? []).slice(0, 10).map((m) => (
              <Stack key={m.id} direction="row" justifyContent="space-between" spacing={2}>
                <Typography variant="body2">
                  {m.type.toLowerCase()} {m.quantityDelta > 0 ? `+${m.quantityDelta}` : m.quantityDelta}
                  {m.reason ? ` · ${m.reason}` : ''}
                </Typography>
                <Typography variant="caption" color="text.secondary">{formatDateTime(m.createdAt)}</Typography>
              </Stack>
            ))}

            {canManage ? (
              <>
                <Divider />
                <Button color="error" onClick={() => setConfirmRemove(true)} disabled={actions.remove.isPending}>
                  Remove this listing
                </Button>
                <ConfirmDialog
                  open={confirmRemove}
                  title="Remove listing"
                  message={`Remove ${listing.productName ?? 'this product'} from your pharmacy? Customers will no longer see it. Stock held for open orders blocks removal.`}
                  confirmLabel="Remove"
                  onClose={() => setConfirmRemove(false)}
                  onConfirm={() => actions.remove.mutate(listing.id, { onSuccess: () => { setConfirmRemove(false); onClose(); } })}
                />
              </>
            ) : null}
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

/**
 * Work 112: the pharmacy's inventory on the real API. Listings with their stock, an add-product
 * dialog on the catalogue, and per listing: price, online sale, batches (receive and adjust, both
 * audited) and the stock movement ledger.
 */
export function InventoryPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const canManage = can('inventory:manage');
  const [branchId, setBranchId] = useState('');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const filters = useMemo(() => ({ branchId: branchId || undefined, page: paging.page + 1, size: paging.pageSize }), [branchId, paging]);
  const { data, isLoading, isFetching, error } = useListings(filters);
  const branchesQuery = useBranches();
  const branches = branchesQuery.data ?? [];
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? 'Branch';

  const columns: GridColDef<InventoryListing>[] = [
    { field: 'productName', headerName: 'Product', flex: 1, minWidth: 200, valueFormatter: (v: string | null) => v ?? 'Unnamed product' },
    ...(branches.length > 1 ? [{ field: 'branchId', headerName: 'Branch', width: 150, valueGetter: (_v: unknown, row: InventoryListing) => branchName(row.branchId) } as GridColDef<InventoryListing>] : []),
    { field: 'price', headerName: 'Price', width: 110, valueGetter: (_v, row) => money(row.price, row.currency) },
    { field: 'onHand', headerName: 'On hand', width: 100, type: 'number' },
    { field: 'reserved', headerName: 'Reserved', width: 100, type: 'number' },
    { field: 'sellable', headerName: 'Sellable', width: 100, type: 'number' },
    { field: 'level', headerName: 'Stock', width: 140, renderCell: ({ row }) => <StatusChip status={LEVEL_LABEL[stockLevel(row)]} /> },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Inventory"
        subtitle="Your pharmacy’s listings, stock and batches. Reserved units are held for open orders."
        actions={canManage ? <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setAdding(true)}>List a product</Button> : undefined}
      />

      {branches.length > 1 ? (
        <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
          <TextField select size="small" label="Branch" value={branchId} onChange={(e) => { setBranchId(e.target.value); setPaging((p) => ({ ...p, page: 0 })); }} sx={{ minWidth: 200 }}>
            <MenuItem value="">All branches</MenuItem>
            {branches.map((b) => (
              <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>
            ))}
          </TextField>
        </Stack>
      ) : null}

      {error ? <Alert severity="error" sx={{ mb: 2 }}>{inventoryErrorMessage(error, 'Inventory could not be loaded.')}</Alert> : null}

      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as InventoryListing).id}
        loading={isLoading || isFetching}
        onRowClick={(row) => setSelected((row as InventoryListing).id)}
        emptyTitle="No products listed"
        emptyDescription="List a catalogue product with its first batch to start selling it."
        server={{ rowCount: data?.total ?? 0, paginationModel: paging, onPaginationModelChange: setPaging, pageSizeOptions: PAGE_SIZES }}
      />

      <ListingDrawer id={selected} branchName={branchName} onClose={() => setSelected(null)} />
      {adding ? <AddListingDialog branches={branches} onClose={() => setAdding(false)} /> : null}
    </>
  );
}
