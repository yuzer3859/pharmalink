import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Grid,
  MenuItem,
  Switch,
  TextField,
} from '@mui/material';
import { useInventoryMutations } from '@/hooks/useInventory';
import { useAuth } from '@/context/AuthContext';
import type { InventoryItem, MedicineForm } from '@/types';

const FORMS: MedicineForm[] = ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Cream', 'Drops'];

interface FormState {
  sku: string;
  name: string;
  genericName: string;
  category: string;
  form: MedicineForm;
  strength: string;
  requiresRx: boolean;
  price: number;
  quantity: number;
  reorderLevel: number;
  batchNo: string;
  expiryDate: string;
}

const emptyState: FormState = {
  sku: '',
  name: '',
  genericName: '',
  category: '',
  form: 'Tablet',
  strength: '',
  requiresRx: false,
  price: 0,
  quantity: 0,
  reorderLevel: 20,
  batchNo: '',
  expiryDate: new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10),
};

interface Props {
  open: boolean;
  item: InventoryItem | null;
  categories: string[];
  onClose: () => void;
}

export function InventoryFormDialog({ open, item, categories, onClose }: Props) {
  const { user } = useAuth();
  const { create, update } = useInventoryMutations();
  const [form, setForm] = useState<FormState>(emptyState);

  useEffect(() => {
    if (item) {
      setForm({
        sku: item.sku,
        name: item.name,
        genericName: item.genericName,
        category: item.category,
        form: item.form,
        strength: item.strength,
        requiresRx: item.requiresRx,
        price: item.price,
        quantity: item.quantity,
        reorderLevel: item.reorderLevel,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate.slice(0, 10),
      });
    } else {
      setForm(emptyState);
    }
  }, [item, open]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = () => {
    const payload = {
      ...form,
      expiryDate: new Date(form.expiryDate).toISOString(),
      pharmacyId: item?.pharmacyId ?? user?.pharmacyId ?? 'ph-1',
      pharmacyName: item?.pharmacyName ?? user?.pharmacyName ?? 'PharmaLink',
    };
    if (item) {
      update.mutate({ id: item.id, patch: payload }, { onSuccess: onClose });
    } else {
      create.mutate(payload, { onSuccess: onClose });
    }
  };

  const submitting = create.isPending || update.isPending;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{item ? 'Edit Product' : 'Add Product'}</DialogTitle>
      <DialogContent dividers>
        <Grid container spacing={2} sx={{ mt: 0 }}>
          <Grid item xs={12} sm={6}>
            <TextField
              label="SKU"
              fullWidth
              size="small"
              value={form.sku}
              onChange={(e) => setField('sku', e.target.value)}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              select
              label="Category"
              fullWidth
              size="small"
              value={form.category}
              onChange={(e) => setField('category', e.target.value)}
            >
              {Array.from(new Set([...categories, form.category].filter(Boolean))).map((c) => (
                <MenuItem key={c} value={c}>
                  {c}
                </MenuItem>
              ))}
              <MenuItem value="General">General</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              label="Product name"
              fullWidth
              size="small"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              label="Generic name"
              fullWidth
              size="small"
              value={form.genericName}
              onChange={(e) => setField('genericName', e.target.value)}
            />
          </Grid>
          <Grid item xs={6} sm={4}>
            <TextField
              select
              label="Form"
              fullWidth
              size="small"
              value={form.form}
              onChange={(e) => setField('form', e.target.value as MedicineForm)}
            >
              {FORMS.map((f) => (
                <MenuItem key={f} value={f}>
                  {f}
                </MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid item xs={6} sm={4}>
            <TextField
              label="Strength"
              fullWidth
              size="small"
              value={form.strength}
              onChange={(e) => setField('strength', e.target.value)}
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              label="Batch no."
              fullWidth
              size="small"
              value={form.batchNo}
              onChange={(e) => setField('batchNo', e.target.value)}
            />
          </Grid>
          <Grid item xs={6} sm={3}>
            <TextField
              label="Price (Br)"
              type="number"
              fullWidth
              size="small"
              value={form.price}
              onChange={(e) => setField('price', Number(e.target.value))}
            />
          </Grid>
          <Grid item xs={6} sm={3}>
            <TextField
              label="Quantity"
              type="number"
              fullWidth
              size="small"
              value={form.quantity}
              onChange={(e) => setField('quantity', Number(e.target.value))}
            />
          </Grid>
          <Grid item xs={6} sm={3}>
            <TextField
              label="Reorder level"
              type="number"
              fullWidth
              size="small"
              value={form.reorderLevel}
              onChange={(e) => setField('reorderLevel', Number(e.target.value))}
            />
          </Grid>
          <Grid item xs={6} sm={3}>
            <TextField
              label="Expiry"
              type="date"
              fullWidth
              size="small"
              InputLabelProps={{ shrink: true }}
              value={form.expiryDate}
              onChange={(e) => setField('expiryDate', e.target.value)}
            />
          </Grid>
          <Grid item xs={12}>
            <FormControlLabel
              control={
                <Switch
                  checked={form.requiresRx}
                  onChange={(e) => setField('requiresRx', e.target.checked)}
                />
              }
              label="Requires prescription (Rx)"
            />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={submitting || !form.name || !form.sku}
        >
          {item ? 'Save changes' : 'Add product'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
