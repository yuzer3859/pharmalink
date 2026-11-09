import { Alert, Grid, Skeleton, Typography } from '@mui/material';
import { PageHeader } from '@/components/common/PageHeader';
import { ChartCard } from '@/components/charts/ChartCard';
import { CategoryBarChart, DistributionPieChart, TrendLineChart } from '@/components/charts/Charts';
import { usePortal } from '@/hooks/usePortal';
import { dashboardErrorMessage, usePharmacyDashboard } from '@/hooks/usePharmacyDashboard';
import { statusSlices, stockBars, weekSeries } from '@/services/pharmacyDashboard.service';

/**
 * Work 116: pharmacy analytics, only what the real API backs (`GET /pharmacy/dashboard`): the
 * week's orders and delivered revenue, orders by status, and stock health. Longer periods and
 * product rankings have no read yet, so they are not shown.
 */
export function AnalyticsPage() {
  const portal = usePortal();
  const { data, isLoading, error } = usePharmacyDashboard();
  return (
    <>
      <PageHeader portalName={portal.title} title="Analytics" subtitle="Your pharmacy’s last 7 days and stock health." />
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{dashboardErrorMessage(error, 'Analytics could not be loaded.')}</Alert> : null}
      {isLoading ? <Skeleton variant="rounded" height={320} /> : null}
      {data ? (
        <Grid container spacing={2.5}>
          <Grid item xs={12} md={6}>
            <ChartCard title="New orders per day">
              <TrendLineChart data={weekSeries(data)} series={[{ key: 'orders', label: 'New orders', color: portal.accent }]} />
            </ChartCard>
          </Grid>
          <Grid item xs={12} md={6}>
            <ChartCard title="Delivered revenue per order day (birr)">
              <TrendLineChart data={weekSeries(data)} series={[{ key: 'revenue', label: 'Delivered revenue', color: '#2e7d32' }]} />
            </ChartCard>
          </Grid>
          <Grid item xs={12} md={6}>
            <ChartCard title="Orders by status">
              {statusSlices(data).length ? <DistributionPieChart data={statusSlices(data)} /> : <Typography variant="body2" color="text.secondary">No orders yet.</Typography>}
            </ChartCard>
          </Grid>
          <Grid item xs={12} md={6}>
            <ChartCard title="Listings by stock level">
              <CategoryBarChart data={stockBars(data)} color={portal.accent} />
            </ChartCard>
          </Grid>
        </Grid>
      ) : null}
    </>
  );
}
