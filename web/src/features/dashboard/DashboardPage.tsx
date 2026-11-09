import { Alert, Card, CardContent, Grid, Skeleton, Stack, Typography } from '@mui/material';
import PaidRoundedIcon from '@mui/icons-material/PaidRounded';
import ShoppingCartRoundedIcon from '@mui/icons-material/ShoppingCartRounded';
import LocalShippingRoundedIcon from '@mui/icons-material/LocalShippingRounded';
import FiberNewRoundedIcon from '@mui/icons-material/FiberNewRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import EventBusyRoundedIcon from '@mui/icons-material/EventBusyRounded';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { ChartCard } from '@/components/charts/ChartCard';
import { DistributionPieChart, RevenueAreaChart } from '@/components/charts/Charts';
import { usePortal } from '@/hooks/usePortal';
import { dashboardErrorMessage, usePharmacyDashboard } from '@/hooks/usePharmacyDashboard';
import { fromMinorUnits } from '@/services/adminOrders.service';
import { attentionItems, countAt, statusSlices, weekSeries } from '@/services/pharmacyDashboard.service';
import { currency, formatDateTime } from '@/utils/format';

/**
 * Work 116: the pharmacy dashboard on the real API (Work 115). What needs attention today, the
 * week's orders and delivered revenue, and stock health. Every figure comes from
 * `GET /pharmacy/dashboard`; nothing is sample data.
 */
export function DashboardPage() {
  const portal = usePortal();
  const { data, isLoading, error } = usePharmacyDashboard();

  return (
    <>
      <PageHeader portalName={portal.title} title="Dashboard" subtitle={data ? `Updated ${formatDateTime(data.generatedAt)}` : 'Today at your pharmacy.'} />
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{dashboardErrorMessage(error, 'The dashboard could not be loaded.')}</Alert> : null}
      {isLoading ? <Skeleton variant="rounded" height={320} /> : null}
      {data ? (
        <>
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6} md={4} lg={2}>
              <StatCard label="New (24 h)" value={String(data.orders.newLast24h)} icon={FiberNewRoundedIcon} accent={portal.accent} />
            </Grid>
            <Grid item xs={12} sm={6} md={4} lg={2}>
              <StatCard label="To accept" value={String(countAt(data, 'PENDING'))} icon={ShoppingCartRoundedIcon} accent={portal.accent} />
            </Grid>
            <Grid item xs={12} sm={6} md={4} lg={2}>
              <StatCard label="Ready for pickup" value={String(countAt(data, 'READY'))} icon={LocalShippingRoundedIcon} accent={portal.accent} />
            </Grid>
            <Grid item xs={12} sm={6} md={4} lg={2}>
              <StatCard label="Delivered (30 days)" value={currency(fromMinorUnits(data.orders.deliveredRevenue30d), data.orders.currency)} icon={PaidRoundedIcon} accent={portal.accent} />
            </Grid>
            <Grid item xs={12} sm={6} md={4} lg={2}>
              <StatCard label="Low or out of stock" value={String(data.stock.lowStock + data.stock.outOfStock)} icon={WarningAmberRoundedIcon} accent={portal.accent} />
            </Grid>
            <Grid item xs={12} sm={6} md={4} lg={2}>
              <StatCard label="Batches expiring" value={String(data.stock.batchesExpiringSoon)} icon={EventBusyRoundedIcon} accent={portal.accent} />
            </Grid>
          </Grid>

          <Card variant="outlined" sx={{ mt: 2.5 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ mb: 1 }}>Needs attention</Typography>
              {attentionItems(data).length === 0 ? (
                <Typography variant="body2" color="text.secondary">Nothing right now.</Typography>
              ) : (
                <Stack component="ul" spacing={0.5} sx={{ pl: 2, m: 0 }}>
                  {attentionItems(data).map((item) => (
                    <Typography component="li" variant="body2" key={item}>{item}</Typography>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>

          <Grid container spacing={2.5} sx={{ mt: 0.5 }}>
            <Grid item xs={12} md={8}>
              <ChartCard title="This week" subheader="New orders, and delivered revenue (birr) by order day">
                <RevenueAreaChart
                  data={weekSeries(data)}
                  series={[
                    { key: 'revenue', label: 'Delivered revenue', color: portal.accent },
                    { key: 'orders', label: 'New orders', color: '#7b1fa2' },
                  ]}
                />
              </ChartCard>
            </Grid>
            <Grid item xs={12} md={4}>
              <ChartCard title="Orders by status">
                {statusSlices(data).length ? <DistributionPieChart data={statusSlices(data)} /> : <Typography variant="body2" color="text.secondary">No orders yet.</Typography>}
              </ChartCard>
            </Grid>
          </Grid>
        </>
      ) : null}
    </>
  );
}
