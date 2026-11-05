import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  Drawer,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { financeErrorMessage } from '@/services/adminFinance.service';
import { approvalErrorMessage } from '@/services/adminApprovals.service';
import { fromMinorUnits } from '@/services/adminOrders.service';
import { gatedMessage, settlementPayoutService } from '@/services/settlementPayout.service';
import { currency, formatDate, formatDateTime } from '@/utils/format';
import type { GatedOutcome, PayoutBeneficiary, PayoutRail, Settlement } from '@/types';

const money = (minor: number, code = 'ETB') => currency(fromMinorUnits(minor), code);

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

const destination = (b: PayoutBeneficiary) =>
  `${b.rail === 'TELEBIRR' ? 'Telebirr' : `Bank ${b.bankCode ?? ''}`} ••••${b.accountIdentifierLast4} · ${b.accountName}`;

/** Registering a pharmacy's payout destination (`finance:payout:any`). A second officer verifies it. */
function BeneficiaryForm({ pharmacyId, onDone }: { pharmacyId: string; onDone: () => void }) {
  const notify = useNotify();
  const [rail, setRail] = useState<PayoutRail>('BANK_TRANSFER');
  const [accountName, setAccountName] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountIdentifier, setAccountIdentifier] = useState('');
  const register = useMutation({
    mutationFn: () => settlementPayoutService.registerBeneficiary(pharmacyId, { rail, accountName, bankCode, accountIdentifier }),
    onSuccess: () => {
      notify('Destination registered. A different finance officer must verify it.');
      onDone();
    },
    onError: (e) => notify(financeErrorMessage(e, 'The destination could not be registered.'), 'error'),
  });
  const incomplete = accountName.trim().length < 2 || accountIdentifier.trim().length < 6 || (rail === 'BANK_TRANSFER' && !bankCode.trim());
  return (
    <Stack spacing={1}>
      <TextField select size="small" label="Rail" value={rail} onChange={(e) => setRail(e.target.value as PayoutRail)}>
        <MenuItem value="BANK_TRANSFER">Bank transfer</MenuItem>
        <MenuItem value="TELEBIRR">Telebirr</MenuItem>
      </TextField>
      <TextField size="small" label="Account name" value={accountName} onChange={(e) => setAccountName(e.target.value)} />
      {rail === 'BANK_TRANSFER' ? (
        <TextField size="small" label="Bank code" value={bankCode} onChange={(e) => setBankCode(e.target.value)} />
      ) : null}
      <TextField
        size="small"
        label={rail === 'TELEBIRR' ? 'Telebirr mobile number' : 'Account number'}
        value={accountIdentifier}
        onChange={(e) => setAccountIdentifier(e.target.value)}
        helperText="Stored encrypted; only the last four characters are shown afterwards."
      />
      <Button variant="outlined" disabled={incomplete || register.isPending} onClick={() => register.mutate()}>
        Register destination
      </Button>
    </Stack>
  );
}

/**
 * One settlement (Work 83): its figures, its payout attempts and destination, and the actions the
 * account may take — approve (`finance:settlement:any`), pay, refresh and destinations
 * (`finance:payout:any`). Approve, pay and verify go to a second officer by default.
 */
export function SettlementDrawer({ settlement, onClose }: { settlement: Settlement | null; onClose: () => void }) {
  const { can } = useAuth();
  const notify = useNotify();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [registering, setRegistering] = useState(false);
  const id = settlement?.settlementId ?? null;
  const payout = useQuery({
    queryKey: ['admin-finance', 'payout', id] as const,
    queryFn: () => settlementPayoutService.payout(id as string),
    enabled: !!id,
  });
  const beneficiaries = useQuery({
    queryKey: ['admin-finance', 'beneficiaries', settlement?.pharmacyId] as const,
    queryFn: () => settlementPayoutService.beneficiaries(settlement!.pharmacyId),
    enabled: !!settlement,
  });
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['admin-finance'] });
    qc.invalidateQueries({ queryKey: ['admin-approvals'] });
  };
  const onGated = (done: string) => (result: GatedOutcome) => {
    refreshAll();
    notify(gatedMessage(result, done));
  };
  const onFailed = (fallback: string) => (e: unknown) => {
    refreshAll();
    notify(approvalErrorMessage(e, fallback), 'error');
  };
  const approve = useMutation({ mutationFn: () => settlementPayoutService.approve(id!, reason), onSuccess: onGated('Settlement approved.'), onError: onFailed('The settlement could not be approved.') });
  const pay = useMutation({ mutationFn: () => settlementPayoutService.pay(id!, reason), onSuccess: onGated('Payout sent.'), onError: onFailed('The payout could not be sent.') });
  const refresh = useMutation({
    mutationFn: () => settlementPayoutService.refresh(id!),
    onSuccess: () => {
      refreshAll();
      notify('Payout status refreshed.');
    },
    onError: onFailed('The payout status could not be refreshed.'),
  });
  const verify = useMutation({
    mutationFn: (beneficiaryId: string) => settlementPayoutService.verifyBeneficiary(beneficiaryId, reason),
    onSuccess: onGated('Destination verified.'),
    onError: onFailed('The destination could not be verified.'),
  });

  const view = payout.data;
  const status = view?.settlement.status ?? settlement?.status;
  const pending = beneficiaries.data?.items.find((b) => b.status === 'PENDING_VERIFICATION') ?? null;
  const busy = approve.isPending || pay.isPending || refresh.isPending || verify.isPending;

  return (
    <Drawer anchor="right" open={!!settlement} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 520 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6">Settlement</Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      {settlement ? (
        <Box sx={{ p: 2 }}>
          <Stack spacing={1.25}>
            {status ? <StatusChip status={status.toLowerCase()} /> : null}
            <Field label="Statement" value={settlement.statementRef} />
            <Field label="Pharmacy" value={settlement.pharmacyId} />
            <Field label="Period" value={`${formatDate(settlement.periodStart)} – ${formatDate(settlement.periodEnd)}`} />
            <Field label="Net payable" value={money(settlement.netPayable, settlement.currency)} />
            <Field label="Refund clawback" value={money(settlement.refundClawback, settlement.currency)} />
            <Field label="Platform revenue" value={money(settlement.platformRevenue, settlement.currency)} />
            {view?.settlement.approvedAt ? <Field label="Approved" value={formatDateTime(view.settlement.approvedAt)} /> : null}
            {view?.settlement.paidAt ? <Field label="Paid" value={formatDateTime(view.settlement.paidAt)} /> : null}
            {payout.error ? <Alert severity="error">{financeErrorMessage(payout.error, 'The payout could not be loaded.')}</Alert> : null}
            {payout.isLoading ? <Skeleton variant="rounded" height={80} /> : null}

            <Divider />
            <Typography variant="subtitle2">Payout destination</Typography>
            {view?.beneficiary ? (
              <Field label="Verified" value={destination(view.beneficiary)} />
            ) : (
              <Alert severity="warning">No verified destination. A payout is refused until one is verified.</Alert>
            )}
            {view?.beneficiary?.payableFrom && new Date(view.beneficiary.payableFrom) > new Date() ? (
              <Alert severity="info">Changed destination: it can receive money from {formatDateTime(view.beneficiary.payableFrom)}.</Alert>
            ) : null}
            {pending ? (
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                <Typography variant="body2">Waiting for verification: {destination(pending)}</Typography>
                {can('finance:payout') ? (
                  <Button size="small" disabled={busy} onClick={() => verify.mutate(pending.id)}>
                    Verify
                  </Button>
                ) : null}
              </Stack>
            ) : null}
            {can('finance:payout') && !pending ? (
              registering ? (
                <BeneficiaryForm
                  pharmacyId={settlement.pharmacyId}
                  onDone={() => {
                    setRegistering(false);
                    refreshAll();
                  }}
                />
              ) : (
                <Button size="small" onClick={() => setRegistering(true)}>
                  {view?.beneficiary ? 'Change destination' : 'Register destination'}
                </Button>
              )
            ) : null}

            {view && view.attempts.length > 0 ? (
              <>
                <Divider />
                <Typography variant="subtitle2">Payout attempts</Typography>
                {view.attempts.map((a) => (
                  <Field
                    key={a.id}
                    label={`${formatDateTime(a.createdAt)} · ${a.reference}`}
                    value={`${a.status}${a.failureReason ? ` — ${a.failureReason}` : ''}${a.providerReference ? ` · ${a.providerReference}` : ''}`}
                  />
                ))}
              </>
            ) : null}

            {(status === 'DRAFT' && can('finance:settle')) ||
            ((status === 'APPROVED' || status === 'FAILED' || status === 'PROCESSING') && can('finance:payout')) ? (
              <>
                <Divider />
                {status !== 'PROCESSING' ? (
                  <TextField size="small" label="Reason (optional, audited)" value={reason} onChange={(e) => setReason(e.target.value)} inputProps={{ maxLength: 500 }} />
                ) : null}
                <Stack direction="row" spacing={1}>
                  {status === 'DRAFT' ? (
                    <Button variant="contained" disabled={busy} onClick={() => approve.mutate()}>
                      Approve for payment
                    </Button>
                  ) : null}
                  {status === 'APPROVED' || status === 'FAILED' ? (
                    <Button variant="contained" color="success" disabled={busy || !view?.beneficiary} onClick={() => pay.mutate()}>
                      {status === 'FAILED' ? 'Retry payout' : 'Pay out'}
                    </Button>
                  ) : null}
                  {status === 'PROCESSING' ? (
                    <Button variant="outlined" disabled={busy} onClick={() => refresh.mutate()}>
                      Refresh payout status
                    </Button>
                  ) : null}
                </Stack>
              </>
            ) : null}
          </Stack>
        </Box>
      ) : null}
    </Drawer>
  );
}
