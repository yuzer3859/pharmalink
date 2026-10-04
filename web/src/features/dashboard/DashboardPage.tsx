import { Grid, Stack } from '@mui/material';
import PaidRoundedIcon from '@mui/icons-material/PaidRounded';
import ShoppingCartRoundedIcon from '@mui/icons-material/ShoppingCartRounded';
import ReceiptRoundedIcon from '@mui/icons-material/ReceiptRounded';
import PercentRoundedIcon from '@mui/icons-material/PercentRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import CancelRoundedIcon from '@mui/icons-material/CancelRounded';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { DataTable } from '@/components/common/DataTable';
import { StatusChip } from '@/components/common/StatusChip';
import { ChartCard } from '@/components/charts/ChartCard';
import { RevenueAreaChart, DistributionPieChart } from '@/components/charts/Charts';
import { LoadingScreen } from '@/components/common/LoadingScreen';
import { useAnalytics } from '@/hooks/useAnalytics';
import { useOrders } from '@/hooks/useOrders';
import { usePortal } from '@/hooks/usePortal';
import { currency, compactNumber, formatDate } from '@/utils/format';
import type { KpiMetric, Order } from '@/types';

const KPI_ICONS: Record<string, typeof PaidRoundedIcon> = {
  revenue: PaidRoundedIcon,
  orders: ShoppingCartRoundedIcon,
  aov: ReceiptRoundedIcon,
  fulfillment: PercentRoundedIcon,
  lowstock: WarningAmberRoundedIcon,
  cancelled: CancelRoundedIcon,
};

const formatKpi = (kpi: KpiMetric) => {
  if (kpi.format === 'currency') return currency(kpi.value);
  if (kpi.format === 'percent') return `${kpi.value}%`;
  return compactNumber(kpi.value);
};

const recentColumns: GridColDef[] = [
  { field: 'reference', headerName: 'Reference', flex: 1, minWidth: 150 },
  { field: 'customerName', headerName: 'Customer', flex: 1, minWidth: 140 },
  {
    field: 'total',
    headerName: 'Total',
    width: 120,
    valueFormatter: (value: number) => currency(value),
  },
  {
    field: 'status',
    headerName: 'Status',
    width: 130,
    renderCell: (params) => <StatusChip status={params.value as string} />,
  },
  {
    field: 'createdAt',
    headerName: 'Placed',
    width: 130,
    valueFormatter: (value: string) => formatDate(value),
  },
];

export function DashboardPage() {
  const portal = usePortal();
  const analytics = useAnalytics();
  const orders = useOrders({});

  if (analytics.isLoading || !analytics.data) return <LoadingScreen />;

  const recent = (orders.data ?? []).slice(0, 8) as Order[];

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Dashboard"
        subtitle="Key metrics and recent activity across your operations."
      />

      <Grid container spacing={2.5}>
        {analytics.data.kpis.map((kpi) => (
          <Grid item xs={12} sm={6} md={4} lg={2} key={kpi.key}>
            <StatCard
              label={kpi.label}
              value={formatKpi(kpi)}
              deltaPct={kpi.deltaPct}
              icon={KPI_ICONS[kpi.key]}
              accent={portal.accent}
            />
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={2.5} sx={{ mt: 0.5 }}>
        <Grid item xs={12} md={8}>
          <ChartCard title="Revenue & Orders" subheader="Trailing performance">
            <RevenueAreaChart
              data={analytics.data.revenueTrend}
              series={[
                { key: 'revenue', label: 'Revenue (Br)', color: portal.accent },
                { key: 'orders', label: 'Orders', color: '#7b1fa2' },
              ]}
            />
          </ChartCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <ChartCard title="Orders by Status">
            <DistributionPieChart data={analytics.data.ordersByStatus} />
          </ChartCard>
        </Grid>
      </Grid>

      <Stack sx={{ mt: 2.5 }}>
        <PageHeader title="Recent Orders" />
        <DataTable
          rows={recent}
          columns={recentColumns}
          loading={orders.isLoading}
          pageSize={10}
          emptyTitle="No orders yet"
          emptyDescription="New orders will appear here as they are placed."
        />
      </Stack>
    </>
  );
}
