import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Chip,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { adminReportsService, isPending, rangeProblem, REPORT_LABELS, type ReportJob, type ReportType } from '@/services/adminReports.service';
import { ApiError } from '@/services/apiClient';
import { formatDateTime } from '@/utils/format';

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}` : fallback;

const STATUS_COLOR: Record<ReportJob['status'], 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  QUEUED: 'default',
  RUNNING: 'info',
  SUCCEEDED: 'success',
  FAILED: 'error',
  EXPIRED: 'warning',
};

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function DownloadButton({ job }: { job: ReportJob }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    // Opened first, synchronously, so the browser does not treat it as an unrequested pop-up.
    const tab = window.open('about:blank', '_blank');
    setBusy(true);
    setError(null);
    try {
      const link = await adminReportsService.download(job.id);
      if (tab) {
        tab.opener = null;
        tab.location.href = link.url;
      }
    } catch (err) {
      tab?.close();
      setError(errorText(err, 'The download could not be started.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack spacing={0.5} alignItems="flex-start">
      <Button size="small" variant="outlined" onClick={open} disabled={busy}>
        Download CSV
      </Button>
      {error ? <Typography variant="caption" color="error">{error}</Typography> : null}
    </Stack>
  );
}

/**
 * Reports (Work 90, `/admin/reports`): ask for a CSV, the server builds it in the background, and
 * the list updates until it is ready. Downloads are five-minute signed links, audited, kept for
 * seven days. Each type needs that data's own read permission, so the form offers only those.
 */
export function AdminReportsPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const allowed = can('reports:view');
  const queryClient = useQueryClient();
  const [type, setType] = useState<ReportType | ''>('');
  const [from, setFrom] = useState(isoDaysAgo(29));
  const [to, setTo] = useState(isoToday());

  const types = useQuery({ queryKey: ['admin-reports', 'types'], queryFn: () => adminReportsService.types(), enabled: allowed });
  const list = useQuery({
    queryKey: ['admin-reports', 'list'],
    queryFn: () => adminReportsService.list(),
    enabled: allowed,
    // Poll only while something is still being built.
    refetchInterval: (query) => (query.state.data?.items.some(isPending) ? 3000 : false),
  });
  const ask = useMutation({
    mutationFn: () => adminReportsService.request({ type: type as ReportType, from, to }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-reports', 'list'] }),
  });

  const header = (
    <PageHeader portalName={portal.title} title="Reports" subtitle="CSV exports built in the background. Downloads are audited and kept for seven days." />
  );
  if (!allowed) {
    return (
      <>
        {header}
        <Alert severity="info">Reports need the report:generate:any permission.</Alert>
      </>
    );
  }

  const offered = types.data?.types.filter((t) => t.allowed) ?? [];
  const problem = type ? rangeProblem(from, to) : 'Choose a report.';

  return (
    <>
      {header}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'flex-start' }}>
            <TextField select label="Report" value={type} onChange={(e) => setType(e.target.value as ReportType)} sx={{ minWidth: 220 }} helperText={type ? REPORT_LABELS[type].help : ' '}>
              {offered.map((t) => (
                <MenuItem key={t.type} value={t.type}>
                  {REPORT_LABELS[t.type].label}
                </MenuItem>
              ))}
            </TextField>
            <TextField type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} helperText="UTC, inclusive" />
            <TextField type="date" label="To" value={to} onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} helperText="UTC, inclusive" />
            <Button variant="contained" onClick={() => ask.mutate()} disabled={!!problem || ask.isPending} sx={{ mt: { md: 1 } }}>
              Request report
            </Button>
          </Stack>
          {type && problem ? <Alert severity="warning" sx={{ mt: 1 }}>{problem}</Alert> : null}
          {ask.isError ? <Alert severity="error" sx={{ mt: 1 }}>{errorText(ask.error, 'The report could not be requested.')}</Alert> : null}
          {ask.isSuccess ? <Alert severity="success" sx={{ mt: 1 }}>Queued. It appears below when ready.</Alert> : null}
        </CardContent>
      </Card>

      {list.error ? (
        <Alert severity="error">{errorText(list.error, 'Reports could not be loaded.')}</Alert>
      ) : list.isLoading || !list.data ? (
        <Skeleton variant="rounded" height={240} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title="No reports yet" description="Request one above." />
      ) : (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Report</TableCell>
                <TableCell>Period</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Rows</TableCell>
                <TableCell>Requested</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {list.data.items.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>{REPORT_LABELS[job.type].label}</TableCell>
                  <TableCell>
                    {job.from} – {job.to}
                  </TableCell>
                  <TableCell>
                    <Chip size="small" color={STATUS_COLOR[job.status]} label={job.status.toLowerCase()} />
                    {job.truncated ? <Typography variant="caption" display="block" color="warning.main">Cut at the row limit; choose a shorter period.</Typography> : null}
                    {job.error ? <Typography variant="caption" display="block" color="error">{job.error}</Typography> : null}
                  </TableCell>
                  <TableCell align="right">{job.rowCount ?? '—'}</TableCell>
                  <TableCell>{formatDateTime(job.createdAt)}</TableCell>
                  <TableCell>{job.status === 'SUCCEEDED' ? <DownloadButton job={job} /> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </>
  );
}
