import { useState } from 'react';
import { Alert, Button, Card, CardContent, Chip, Skeleton, Stack, Typography } from '@mui/material';
import type { GridColDef } from '@mui/x-data-grid';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable } from '@/components/common/DataTable';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { financeErrorMessage } from '@/services/adminFinance.service';
import { fromMinorUnits } from '@/services/adminOrders.service';
import { financeStatementsService, TRIGGER_TEXT, type SettlementDue } from '@/services/financeStatements.service';
import { currency, formatDate, formatDateTime } from '@/utils/format';

const money = (minor: number, code = 'ETB') => currency(fromMinorUnits(minor), code);

/**
 * Work 125 (deviation 6): who is owed since their last statement, and a **Run statement** action.
 * A run makes a draft; approval and payout then need a second finance officer, in the drawer of the
 * statement below.
 */
export function StatementsDue() {
  const { can } = useAuth();
  const notify = useNotify();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<SettlementDue | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ['admin-finance', 'due'], queryFn: () => financeStatementsService.due() });
  const run = useMutation({
    mutationFn: (due: SettlementDue) => financeStatementsService.run(due),
    onSuccess: (result) =>
      notify(
        result.replay
          ? `Statement ${result.settlement.statementRef} already existed for that period.`
          : `Draft statement ${result.settlement.statementRef} created for ${money(result.settlement.netPayable, result.settlement.currency)}. Open it below to ask for approval.`,
      ),
    onError: (e) => notify(financeErrorMessage(e, 'The statement could not be run.'), 'error'),
    onSettled: () => {
      setConfirming(null);
      qc.invalidateQueries({ queryKey: ['admin-finance'] });
    },
  });

  const columns: GridColDef<SettlementDue>[] = [
    { field: 'pharmacyName', headerName: 'Pharmacy', flex: 1, minWidth: 180, valueGetter: (_v, row) => row.pharmacyName ?? row.pharmacyId },
    { field: 'period', headerName: 'Since', width: 140, valueGetter: (_v, row) => (row.lastStatement ? formatDate(row.periodStart) : 'First statement') },
    { field: 'netPayable', headerName: 'Owed now', width: 130, valueGetter: (_v, row) => money(row.netPayable, row.currency) },
    { field: 'lineCount', headerName: 'Lines', width: 80, type: 'number' },
    {
      field: 'autoRunTrigger',
      headerName: 'Automatic run',
      width: 150,
      renderCell: ({ row }) => <Chip size="small" label={row.autoRunTrigger ? 'Due now' : 'Would wait'} color={row.autoRunTrigger ? 'warning' : 'default'} />,
    },
    {
      field: 'actions',
      headerName: '',
      width: 150,
      sortable: false,
      renderCell: ({ row }) =>
        can('finance:settle') ? (
          <Button size="small" variant="contained" disabled={run.isPending} onClick={() => setConfirming(row)}>
            Run statement
          </Button>
        ) : null,
    },
  ];

  return (
    <Stack spacing={1.5} sx={{ mb: 3 }}>
      <Typography variant="subtitle1">Owed since the last statement</Typography>
      {error ? <Alert severity="error">{financeErrorMessage(error, 'What is owed could not be loaded.')}</Alert> : null}
      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        getRowId={(row) => `${(row as SettlementDue).pharmacyId}:${(row as SettlementDue).currency}`}
        loading={isLoading}
        pageSize={10}
        emptyTitle="Nothing owed"
        emptyDescription="Every pharmacy is settled up to its last statement."
      />
      <ConfirmDialog
        open={!!confirming}
        title="Run statement"
        message={
          confirming
            ? `Create a draft statement for ${confirming.pharmacyName ?? confirming.pharmacyId}, ${confirming.lastStatement ? `from ${formatDate(confirming.periodStart)}` : 'its first'} to now, for about ${money(confirming.netPayable, confirming.currency)}? ${confirming.autoRunTrigger ? TRIGGER_TEXT[confirming.autoRunTrigger] ?? '' : ''} A second finance officer approves it before any payout.`
            : ''
        }
        confirmLabel="Create draft"
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && run.mutate(confirming)}
      />
    </Stack>
  );
}

/** Work 125 (deviation 8): the accounting reconciliation report, read-only. */
export function ReconciliationTab() {
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['admin-finance', 'reconciliation'],
    queryFn: () => financeStatementsService.reconciliation(),
  });
  return (
    <Stack spacing={2}>
      <Alert severity="info">
        Checks every captured payment against its ledger postings, the books for balance, and each statement against the ledger. It only reports; it never corrects.
      </Alert>
      {error ? <Alert severity="error">{financeErrorMessage(error, 'The reconciliation could not be run.')}</Alert> : null}
      {isLoading ? <Skeleton variant="rounded" height={160} /> : null}
      {data ? (
        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Chip label={data.status === 'CLEAN' ? 'CLEAN' : 'Discrepancies found'} color={data.status === 'CLEAN' ? 'success' : 'error'} />
              <Typography variant="body2" color="text.secondary">Checked {formatDateTime(data.checkedAt)}</Typography>
              <Button size="small" disabled={isFetching} onClick={() => refetch()} sx={{ ml: 'auto' }}>
                {isFetching ? 'Checking…' : 'Check again'}
              </Button>
            </Stack>
            <Typography variant="body2" sx={{ mt: 1.5 }}>
              Examined {data.scope.capturedPaymentsExamined} captured payments, {data.scope.settlementsExamined} statements
              {data.scope.settlementLinesExamined !== undefined ? `, ${data.scope.settlementLinesExamined} statement lines` : ''}
              {data.scope.currenciesExamined !== undefined ? ` and ${data.scope.currenciesExamined} currencies` : ''}.
            </Typography>
            {data.discrepancies.length > 0 ? (
              <Stack spacing={1} sx={{ mt: 2 }} component="ul">
                {data.discrepancies.map((d, i) => (
                  <Typography component="li" variant="body2" key={`${d.code}-${d.subject}-${i}`}>
                    <strong>{d.code.replace(/_/g, ' ').toLowerCase()}</strong>: {d.description}
                    {d.amount !== null ? ` (${money(d.amount, d.currency ?? 'ETB')})` : ''}
                  </Typography>
                ))}
              </Stack>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </Stack>
  );
}
