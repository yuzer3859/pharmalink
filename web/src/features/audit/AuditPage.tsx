import { useMemo, useState } from 'react';
import { Alert, Stack, TextField, Tooltip, Typography } from '@mui/material';
import type { GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { useAudit } from '@/hooks/useAudit';
import { usePortal } from '@/hooks/usePortal';
import { AUDIT_PAGE_SIZES, isActorIdFilter } from '@/services/audit.service';
import { ApiError } from '@/services/apiClient';
import { formatDateTime } from '@/utils/format';
import type { AuditLog } from '@/types';

const shortHash = (hash: string) => `${hash.slice(0, 10)}…`;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'Your account is not allowed to read the audit trail.';
    if (error.status === 400) return 'One of the filters is not valid.';
    return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  }
  return 'The audit trail could not be loaded.';
}

/**
 * The read-only audit explorer (`GET /admin/audit`, module-16 §9.7): the hash-chained trail,
 * newest first, paged by the server. Filters are exact matches, as the API defines them.
 */
export function AuditPage() {
  const portal = usePortal();
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: AUDIT_PAGE_SIZES[0] });

  const actorInvalid = actorUserId.trim() !== '' && !isActorIdFilter(actorUserId);
  const filters = useMemo(
    () => ({
      action,
      resourceType,
      actorUserId: actorInvalid ? undefined : actorUserId,
      page: paging.page + 1,
      size: paging.pageSize,
    }),
    [action, resourceType, actorUserId, actorInvalid, paging],
  );
  const { data, isLoading, isFetching, error } = useAudit(filters);

  // A filter change starts again from the first page.
  const onFilter = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPaging((p) => ({ ...p, page: 0 }));
  };

  const columns: GridColDef<AuditLog>[] = [
    {
      field: 'createdAt',
      headerName: 'Time',
      width: 170,
      valueFormatter: (value: string) => formatDateTime(value),
    },
    { field: 'action', headerName: 'Action', flex: 1.4, minWidth: 220 },
    { field: 'resourceType', headerName: 'Resource', width: 150 },
    { field: 'resourceId', headerName: 'Resource id', flex: 1, minWidth: 160, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'actorUserId', headerName: 'Actor', flex: 1, minWidth: 160, valueFormatter: (v: string | null) => v ?? 'System' },
    { field: 'ip', headerName: 'IP address', width: 140, valueFormatter: (v: string | null) => v ?? '—' },
    {
      field: 'chain',
      headerName: 'Hash',
      width: 130,
      sortable: false,
      renderCell: ({ row }) => (
        <Tooltip title={row.chain.hash}>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            {shortHash(row.chain.hash)}
          </Typography>
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Audit Logs"
        subtitle="Read-only, hash-chained trail of sensitive actions across the platform."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="Action (exact)"
          placeholder="e.g. CONFIG_CHANGED"
          value={action}
          onChange={(e) => onFilter(setAction)(e.target.value)}
          sx={{ minWidth: 220 }}
        />
        <TextField
          size="small"
          label="Resource type (exact)"
          placeholder="e.g. Pharmacy"
          value={resourceType}
          onChange={(e) => onFilter(setResourceType)(e.target.value)}
          sx={{ minWidth: 200 }}
        />
        <TextField
          size="small"
          label="Actor user id"
          value={actorUserId}
          error={actorInvalid}
          helperText={actorInvalid ? 'Enter a full user id (UUID).' : undefined}
          onChange={(e) => onFilter(setActorUserId)(e.target.value)}
          sx={{ minWidth: 300 }}
        />
      </Stack>

      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {errorMessage(error)}
        </Alert>
      ) : null}

      <DataTable
        rows={data?.items ?? []}
        columns={columns as GridColDef[]}
        loading={isLoading || isFetching}
        emptyTitle="No audit entries"
        emptyDescription="Audit events matching your filters will appear here."
        server={{
          rowCount: data?.total ?? 0,
          paginationModel: paging,
          onPaginationModelChange: setPaging,
          pageSizeOptions: [...AUDIT_PAGE_SIZES],
        }}
      />
    </>
  );
}
