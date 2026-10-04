import { Grid } from '@mui/material';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { ChartCard } from '@/components/charts/ChartCard';
import {
  RevenueAreaChart,
  TrendLineChart,
  CategoryBarChart,
  DistributionPieChart,
} from '@/components/charts/Charts';
import { LoadingScreen } from '@/components/common/LoadingScreen';
import { useAnalytics } from '@/hooks/useAnalytics';
import { usePortal } from '@/hooks/usePortal';
import { currency, compactNumber } from '@/utils/format';
import type { KpiMetric } from '@/types';

const formatKpi = (kpi: KpiMetric) => {
  if (kpi.format === 'currency') return currency(kpi.value);
  if (kpi.format === 'percent') return `${kpi.value}%`;
  return compactNumber(kpi.value);
};

export function AnalyticsPage() {
  const portal = usePortal();
  const { data, isLoading } = useAnalytics();

  if (isLoading || !data) return <LoadingScreen />;

  return (
    <>
      <PageHeader
        portalName={portal.title}
        title="Analytics"
        subtitle="Understand revenue, fulfilment and product performance trends."
      />

      <Grid container spacing={2.5}>
        {data.kpis.slice(0, 4).map((kpi) => (
          <Grid item xs={12} sm={6} md={3} key={kpi.key}>
            <StatCard
              label={kpi.label}
              value={formatKpi(kpi)}
              deltaPct={kpi.deltaPct}
              accent={portal.accent}
            />
          </Grid>
        ))}

        <Grid item xs={12} md={7}>
          <ChartCard title="Revenue & Orders Trend">
            <RevenueAreaChart
              data={data.revenueTrend}
              series={[
                { key: 'revenue', label: 'Revenue (Br)', color: portal.accent },
                { key: 'orders', label: 'Orders', color: '#7b1fa2' },
              ]}
            />
          </ChartCard>
        </Grid>
        <Grid item xs={12} md={5}>
          <ChartCard title="Orders by Status">
            <DistributionPieChart data={data.ordersByStatus} />
          </ChartCard>
        </Grid>

        <Grid item xs={12} md={7}>
          <ChartCard title="Top Categories by Stock Volume">
            <CategoryBarChart data={data.topCategories} color={portal.accent} />
          </ChartCard>
        </Grid>
        <Grid item xs={12} md={5}>
          <ChartCard title="Fulfilment vs Cancellation (%)">
            <TrendLineChart
              data={data.fulfillmentTrend}
              series={[
                { key: 'fulfilled', label: 'Fulfilled %', color: '#2e7d32' },
                { key: 'cancelled', label: 'Cancelled %', color: '#d32f2f' },
              ]}
            />
          </ChartCard>
        </Grid>
      </Grid>
    </>
  );
}
