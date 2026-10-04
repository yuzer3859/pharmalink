import { Card } from '@mui/material';
import { DataGrid, type GridColDef, type GridRowsProp } from '@mui/x-data-grid';
import { EmptyState } from './EmptyState';

interface DataTableProps {
  rows: GridRowsProp;
  columns: GridColDef[];
  loading?: boolean;
  pageSize?: number;
  emptyTitle?: string;
  emptyDescription?: string;
  autoHeight?: boolean;
}

export function DataTable({
  rows,
  columns,
  loading,
  pageSize = 10,
  emptyTitle,
  emptyDescription,
  autoHeight = true,
}: DataTableProps) {
  return (
    <Card sx={{ overflow: 'hidden' }}>
      <DataGrid
        rows={rows}
        columns={columns}
        loading={loading}
        autoHeight={autoHeight}
        disableRowSelectionOnClick
        pageSizeOptions={[10, 25, 50]}
        initialState={{ pagination: { paginationModel: { pageSize } } }}
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
