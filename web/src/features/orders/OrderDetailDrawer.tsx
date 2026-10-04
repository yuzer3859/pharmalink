import {
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { StatusChip } from '@/components/common/StatusChip';
import { LoadingScreen } from '@/components/common/LoadingScreen';
import { useOrder, useOrderStatusMutation } from '@/hooks/useOrders';
import { ORDER_FLOW } from '@/services/orders.service';
import { useAuth } from '@/context/AuthContext';
import { currency, formatDateTime } from '@/utils/format';
import type { OrderStatus } from '@/types';

export function OrderDetailDrawer({
  orderId,
  onClose,
}: {
  orderId: string | null;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const canManage = can('orders:manage');
  const { data: order, isLoading } = useOrder(orderId);
  const statusMutation = useOrderStatusMutation();

  const activeStep = order ? ORDER_FLOW.indexOf(order.status as OrderStatus) : -1;
  const nextStatus = activeStep >= 0 && activeStep < ORDER_FLOW.length - 1 ? ORDER_FLOW[activeStep + 1] : null;
  const isCancelled = order?.status === 'cancelled';

  return (
    <Drawer anchor="right" open={!!orderId} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 460 } } }}>
      {isLoading || !order ? (
        <LoadingScreen />
      ) : (
        <Box sx={{ p: 3 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
            <Box>
              <Typography variant="h6">{order.reference}</Typography>
              <Typography variant="caption" color="text.secondary">
                {formatDateTime(order.createdAt)}
              </Typography>
            </Box>
            <IconButton onClick={onClose}>
              <CloseRoundedIcon />
            </IconButton>
          </Stack>

          <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
            <StatusChip status={order.status} />
            <StatusChip status={order.paymentStatus} />
            {order.requiresRx && <Chip label="Rx Required" size="small" color="secondary" />}
          </Stack>

          <Divider sx={{ my: 2 }} />

          <Stack spacing={1}>
            <Row label="Customer" value={order.customerName} />
            <Row label="Pharmacy" value={order.pharmacyName} />
            <Row label="Delivery zone" value={order.deliveryZone} />
            <Row label="Items" value={String(order.itemCount)} />
          </Stack>

          <Divider sx={{ my: 2 }} />

          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Items
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Product</TableCell>
                <TableCell align="right">Qty</TableCell>
                <TableCell align="right">Price</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {order.lines.map((line, i) => (
                <TableRow key={i}>
                  <TableCell>{line.name}</TableCell>
                  <TableCell align="right">{line.quantity}</TableCell>
                  <TableCell align="right">{currency(line.unitPrice)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell colSpan={2} sx={{ fontWeight: 700, border: 0 }}>
                  Total
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 700, border: 0 }}>
                  {currency(order.total)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>

          <Divider sx={{ my: 2 }} />

          <Typography variant="subtitle2" sx={{ mb: 2 }}>
            Fulfilment progress
          </Typography>
          {isCancelled ? (
            <StatusChip status="cancelled" size="medium" />
          ) : (
            <Stepper activeStep={activeStep} alternativeLabel>
              {ORDER_FLOW.map((step) => (
                <Step key={step}>
                  <StepLabel>{step}</StepLabel>
                </Step>
              ))}
            </Stepper>
          )}

          {canManage && !isCancelled && (
            <Stack direction="row" spacing={1.5} sx={{ mt: 3 }}>
              {nextStatus && (
                <Button
                  variant="contained"
                  fullWidth
                  disabled={statusMutation.isPending}
                  onClick={() => statusMutation.mutate({ id: order.id, status: nextStatus })}
                >
                  Advance to {nextStatus}
                </Button>
              )}
              <Button
                variant="outlined"
                color="error"
                fullWidth
                disabled={statusMutation.isPending}
                onClick={() => statusMutation.mutate({ id: order.id, status: 'cancelled' })}
              >
                Cancel order
              </Button>
            </Stack>
          )}
        </Box>
      )}
    </Drawer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between">
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" fontWeight={600}>
        {value}
      </Typography>
    </Stack>
  );
}
