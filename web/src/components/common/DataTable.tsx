import { Card } from '@mui/material';
import { DataGrid, type GridColDef, type GridPaginationModel, type GridRowIdGetter, type GridRowsProp } from '@mui/x-data-grid';
import { EmptyState } from './EmptyState';

interface DataTableProps {
  rows: GridRowsProp;
  columns: GridColDef[];
  loading?: boolean;
  pageSize?: number;
  emptyTitle?: string;
  emptyDescription?: string;
  autoHeight?: boolean;
  /** For rows whose key is not `id`. */
  getRowId?: GridRowIdGetter;
  /** Server-side paging: the grid shows one page the server returned and asks for the next. */
  server?: {
    rowCount: number;
    paginationModel: GridPaginationModel;
    onPaginationModelChange: (model: GridPaginationModel) => void;
    pageSizeOptions?: number[];
  };
}

export function DataTable({
  rows,
  columns,
  loading,
  pageSize = 10,
  emptyTitle,
  emptyDescription,
  autoHeight = true,
  getRowId,
  server,
}: DataTableProps) {
  const paging = server
    ? {
        paginationMode: 'server' as const,
        rowCount: server.rowCount,
        paginationModel: server.paginationModel,
        onPaginationModelChange: server.onPaginationModelChange,
        pageSizeOptions: server.pageSizeOptions ?? [10, 25, 50],
      }
    : {
        pageSizeOptions: [10, 25, 50],
        initialState: { pagination: { paginationModel: { pageSize } } },
      };
  return (
    <Card sx={{ overflow: 'hidden' }}>
      <DataGrid
        rows={rows}
        columns={columns}
        getRowId={getRowId}
        loading={loading}
        autoHeight={autoHeight}
        disableRowSelectionOnClick
        {...paging}
        slots={{
          noRowsOverlay: () => (
            <EmptyState title={emptyTitle} description={emptyDescription} />
          ),
        }}
        sx={{
          border: 0,
          '--DataGrid-overlayHeight': '320px',
          '& .MuiDataGrid-columnHeaders': { bgcolor: 'action.hover' },
          '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': { outline: 'none' },
          '& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': {
            outline: 'none',
          },
        }}
      />
    </Card>
  );
}
