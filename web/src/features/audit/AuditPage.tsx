import { useMemo, useState } from 'react';
import { MenuItem, Stack, TextField } from '@mui/material';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { SearchInput } from '@/components/common/SearchInput';
import { useAudit } from '@/hooks/useAudit';
import { usePortal } from '@/hooks/usePortal';
import { formatDateTime } from '@/utils/format';
import type { AuditLog } from '@/types';

export function AuditPage() {
  const portal = usePortal();
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState<AuditLog['severity'] | 'all'>('all');

  const filters = useMemo(() => ({ search, severity }), [search, severity]);
  const { data = [], isLoading } = useAudit(filters);

  const columns: GridColDef[] = [
    {
      field: 'timestamp',
      headerName: 'Time',
      width: 170,
      valueFormatter: (value: string) => formatDateTime(value),
    },
    { field: 'actor', headerName: 'Actor', flex: 1, minWidth: 160 },
    { field: 'action', headerName: 'Action', flex: 1.4, minWidth: 200 },
    { field: 'entity', headerName: 'Entity', width: 120 },
    {
      field: 'severity',
      headerName: 'Severity',
      width: 120,
      renderCell: (params) => <StatusChip status={params.value as string} />,
    },
    { field: 'ip', headerName: 'IP address', width: 140 },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Audit Logs"
        subtitle="Immutable trail of sensitive actions across the platform."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search actor or action" />
        <TextField
          select
          size="small"
          label="Severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as AuditLog['severity'] | 'all')}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="all">All severities</MenuItem>
          <MenuItem value="info">Info</MenuItem>
          <MenuItem value="warning">Warning</MenuItem>
          <MenuItem value="critical">Critical</MenuItem>
        </TextField>
      </Stack>

      <DataTable
        rows={data}
        columns={columns}
        loading={isLoading}
        pageSize={25}
        emptyTitle="No audit entries"
        emptyDescription="Audit events matching your filters will appear here."
      />
    </>
  );
}
