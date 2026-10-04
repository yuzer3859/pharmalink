import { Chip } from '@mui/material';

type Tone = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';

const TONE_MAP: Record<string, Tone> = {
  // stock
  in_stock: 'success',
  low_stock: 'warning',
  out_of_stock: 'error',
  expired: 'error',
  // orders
  placed: 'info',
  verified: 'info',
  accepted: 'primary',
  dispatched: 'primary',
  delivered: 'success',
  completed: 'success',
  cancelled: 'error',
  // payments
  pending: 'warning',
  authorized: 'info',
  paid: 'success',
  refunded: 'default',
  failed: 'error',
  // generic entity status
  active: 'success',
  invited: 'info',
  suspended: 'error',
  ready: 'success',
  scheduled: 'info',
  generating: 'warning',
  // audit severity
  info: 'info',
  warning: 'warning',
  critical: 'error',
};

const humanize = (value: string) =>
  value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function StatusChip({ status, size = 'small' }: { status: string; size?: 'small' | 'medium' }) {
  const tone = TONE_MAP[status] ?? 'default';
  return (
    <Chip
      label={humanize(status)}
      size={size}
      color={tone === 'default' ? 'default' : tone}
      variant={tone === 'default' ? 'outlined' : 'filled'}
      sx={{ '& .MuiChip-label': { px: 1.2 } }}
    />
  );
}
