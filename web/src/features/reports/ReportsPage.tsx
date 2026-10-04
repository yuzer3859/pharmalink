import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { useReports, useReportTemplates, useGenerateReport } from '@/hooks/useReports';
import { useNotify } from '@/context/NotificationContext';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { formatDateTime } from '@/utils/format';
import type { ReportRecord } from '@/types';

const PERIODS = ['Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'Q1 2026'];
const FORMATS: ReportRecord['format'][] = ['PDF', 'CSV', 'XLSX'];

export function ReportsPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const notify = useNotify();
  const canExport = can('reports:export');

  const { data = [], isLoading } = useReports();
  const { data: templates = [] } = useReportTemplates();
  const generate = useGenerateReport();

  const [open, setOpen] = useState(false);
  const [type, setType] = useState('');
  const [period, setPeriod] = useState(PERIODS[0]);
  const [format, setFormat] = useState<ReportRecord['format']>('PDF');

  const submit = () => {
    const chosen = type || templates[0] || 'Sales Summary';
    generate.mutate(
      { name: `${chosen} — ${period}`, type: chosen, period, format },
      { onSuccess: () => setOpen(false) },
    );
  };

  const columns: GridColDef[] = [
    { field: 'name', headerName: 'Report', flex: 1.4, minWidth: 220 },
    { field: 'type', headerName: 'Type', flex: 1, minWidth: 150 },
    { field: 'period', headerName: 'Period', width: 120 },
    { field: 'format', headerName: 'Format', width: 100 },
    {
      field: 'status',
      headerName: 'Status',
      width: 130,
      renderCell: (params) => <StatusChip status={params.value as string} />,
    },
    { field: 'generatedBy', headerName: 'By', width: 150 },
    {
      field: 'generatedAt',
      headerName: 'Generated',
      width: 170,
      valueFormatter: (value: string) => formatDateTime(value),
    },
    {
      field: 'actions',
      headerName: '',
      width: 70,
      sortable: false,
      filterable: false,
      renderCell: (params) => {
        const row = params.row as ReportRecord;
        return (
          <Tooltip title={row.status === 'ready' ? 'Download' : 'Not ready'}>
            <span>
              <IconButton
                size="small"
                disabled={!canExport || row.status !== 'ready'}
                onClick={() => notify(`Downloading ${row.name} (${row.format})`, 'info')}
              >
                <DownloadRoundedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Reports"
        subtitle="Generate, schedule and export operational and compliance reports."
        actions={
          canExport ? (
            <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setOpen(true)}>
              Generate Report
            </Button>
          ) : undefined
        }
      />

      <DataTable
        rows={data}
        columns={columns}
        loading={isLoading}
        emptyTitle="No reports yet"
        emptyDescription="Generate a report to see it listed here."
      />

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Generate Report</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField
              select
              label="Report type"
              size="small"
              value={type || templates[0] || ''}
              onChange={(e) => setType(e.target.value)}
            >
              {templates.map((t) => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Period"
              size="small"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              {PERIODS.map((p) => (
                <MenuItem key={p} value={p}>
                  {p}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Format"
              size="small"
              value={format}
              onChange={(e) => setFormat(e.target.value as ReportRecord['format'])}
            >
              {FORMATS.map((f) => (
                <MenuItem key={f} value={f}>
                  {f}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="contained" onClick={submit} disabled={generate.isPending}>
            Generate
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
