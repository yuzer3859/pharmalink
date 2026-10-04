import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { SearchInput } from '@/components/common/SearchInput';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { InventoryFormDialog } from './InventoryFormDialog';
import { useInventory, useInventoryCategories, useInventoryMutations } from '@/hooks/useInventory';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { currency, formatDate } from '@/utils/format';
import type { InventoryItem, StockStatus } from '@/types';

const STATUS_OPTIONS: Array<{ value: StockStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'in_stock', label: 'In stock' },
  { value: 'low_stock', label: 'Low stock' },
  { value: 'out_of_stock', label: 'Out of stock' },
  { value: 'expired', label: 'Expired' },
];

export function InventoryPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const canManage = can('inventory:manage');

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState<StockStatus | 'all'>('all');
  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [toDelete, setToDelete] = useState<InventoryItem | null>(null);

  const filters = useMemo(() => ({ search, category, status }), [search, category, status]);
  const { data = [], isLoading } = useInventory(filters);
  const { data: categories = [] } = useInventoryCategories();
  const { remove } = useInventoryMutations();

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (item: InventoryItem) => {
    setEditing(item);
    setFormOpen(true);
  };

  const columns: GridColDef[] = [
    { field: 'sku', headerName: 'SKU', width: 150 },
    { field: 'name', headerName: 'Product', flex: 1, minWidth: 160 },
    { field: 'genericName', headerName: 'Generic', flex: 1, minWidth: 160 },
    { field: 'category', headerName: 'Category', width: 130 },
    { field: 'form', headerName: 'Form', width: 100 },
    {
      field: 'price',
      headerName: 'Price',
      width: 110,
      valueFormatter: (value: number) => currency(value),
    },
    { field: 'quantity', headerName: 'Qty', width: 90, type: 'number' },
    {
      field: 'expiryDate',
      headerName: 'Expiry',
      width: 120,
      valueFormatter: (value: string) => formatDate(value),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 140,
      renderCell: (params) => <StatusChip status={params.value as string} />,
    },
    {
      field: 'actions',
      headerName: '',
      width: 100,
      sortable: false,
      filterable: false,
      renderCell: (params) =>
        canManage ? (
          <Stack direction="row">
            <Tooltip title="Edit">
              <IconButton size="small" onClick={() => openEdit(params.row as InventoryItem)}>
                <EditRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton size="small" onClick={() => setToDelete(params.row as InventoryItem)}>
                <DeleteOutlineRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Inventory"
        subtitle="Track stock levels, pricing and expiry across your catalogue."
        actions={
          canManage ? (
            <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={openCreate}>
              Add Product
            </Button>
          ) : undefined
        }
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, generic or SKU" />
        <TextField
          select
          size="small"
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="all">All categories</MenuItem>
          {categories.map((c) => (
            <MenuItem key={c} value={c}>
              {c}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as StockStatus | 'all')}
          sx={{ minWidth: 180 }}
        >
          {STATUS_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>
        <Box sx={{ flex: 1 }} />
      </Stack>

      <DataTable
        rows={data}
        columns={columns}
        loading={isLoading}
        emptyTitle="No products found"
        emptyDescription="Try adjusting your filters or add a new product to your catalogue."
      />

      <InventoryFormDialog
        open={formOpen}
        item={editing}
        categories={categories}
        onClose={() => setFormOpen(false)}
      />

      <ConfirmDialog
        open={!!toDelete}
        title="Remove product"
        message={`Remove "${toDelete?.name}" from inventory? This cannot be undone.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}
