import { useState } from 'react';
import { Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '@/context/NotificationContext';
import { approvalErrorMessage } from '@/services/adminApprovals.service';
import { gatedMessage, settlementPayoutService } from '@/services/settlementPayout.service';
import { parseBirr } from '@/services/adminRefund.service';

/**
 * A manual refund from the finance portal (Work 84, `finance:refund:any`). The server decides: at
 * or below the high-value threshold it is carried out now; above it, a different finance officer
 * must approve it on the Approvals page.
 */
export function RefundForm({ paymentId, remaining, currency }: { paymentId: string; remaining: number; currency: string }) {
  const notify = useNotify();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [destination, setDestination] = useState<'ORIGINAL' | 'WALLET'>('ORIGINAL');
  const parsed = amount.trim() === '' ? null : parseBirr(amount);
  const invalid = parsed === undefined || (parsed !== null && (parsed <= 0 || parsed > remaining));
  const refund = useMutation({
    mutationFn: () => settlementPayoutService.refund(paymentId, { amount: parsed ?? undefined, reason, destination }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['admin-finance'] });
      qc.invalidateQueries({ queryKey: ['admin-approvals'] });
      notify(gatedMessage(result, 'Refund carried out.'));
      setAmount('');
      setReason('');
    },
    onError: (e) => notify(approvalErrorMessage(e, 'The refund could not be made.'), 'error'),
  });

  if (remaining <= 0) return null;
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">Refund</Typography>
      <TextField
        size="small"
        label={`Amount in ${currency} (empty = everything refundable)`}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={invalid}
        helperText={invalid ? 'Enter an amount above zero and no more than what is still refundable.' : undefined}
      />
      <TextField size="small" label="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} inputProps={{ maxLength: 500 }} />
      <TextField select size="small" label="Refund to" value={destination} onChange={(e) => setDestination(e.target.value as 'ORIGINAL' | 'WALLET')}>
        <MenuItem value="ORIGINAL">Original payment method</MenuItem>
        <MenuItem value="WALLET">Customer wallet</MenuItem>
      </TextField>
      <Button variant="outlined" color="warning" disabled={invalid || !reason.trim() || refund.isPending} onClick={() => refund.mutate()}>
        Refund
      </Button>
    </Stack>
  );
}
