import { Alert, Grid, Skeleton, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useQuery } from '@tanstack/react-query';
import PeopleRoundedIcon from '@mui/icons-material/PeopleRounded';
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded';
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded';
import LocalShippingRoundedIcon from '@mui/icons-material/LocalShippingRounded';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { ChartCard } from '@/components/charts/ChartCard';
import { CategoryBarChart, DistributionPieChart } from '@/components/charts/Charts';
import { EmptyState } from '@/components/common/EmptyState';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { adminAnalyticsService, toChartData } from '@/services/adminAnalytics.service';
import { fromMinorUnits } from '@/services/adminOrders.service';
import { ApiError } from '@/services/apiClient';
import { compactNumber, currency, formatDateTime } from '@/utils/format';
import type { CategoryDatum } from '@/types';

function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Your account is not allowed to read platform analytics.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return 'Analytics could not be loaded.';
}

function Breakdown({ title, data, kind = 'bar', color }: { title: string; data: CategoryDatum[]; kind?: 'bar' | 'pie'; color: string }) {
  return (
    <ChartCard title={title} height={260}>
      {data.length === 0 ? (
        <EmptyState title="Nothing yet" description="No records in this area." />
      ) : kind === 'pie' ? (
        <DistributionPieChart data={data} />
      ) : (
        <CategoryBarChart data={data} color={color} />
      )}
    </ChartCard>
  );
}

/**
 * Platform overview for the admin portals (`GET /admin/analytics/overview`, `analytics:read`):
 * current counts per area and the COD cash summary. A snapshot, not a trend: the API has no time
 * series, so the page draws none.
 */
export function AdminOverviewPage({ title = 'Overview' }: { title?: string }) {
  const portal = usePortal();
  const theme = useTheme();
  const { can } = useAuth();
  const allowed = can('analytics:view');
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-analytics', 'overview'] as const,
    queryFn: () => adminAnalyticsService.overview(),
    enabled: allowed,
  });

  const header = (
    <PageHeader
      portalName={portal.title}
      title={title}
      subtitle={data ? `Platform snapshot generated ${formatDateTime(data.generatedAt)}.` : 'Platform snapshot: current counts per area.'}
    />
  );

  if (!allowed) {
    return (
      <>
        {header}
        <Alert severity="info">Platform analytics need the analytics:read permission.</Alert>
      </>
    );
  }
  if (error) {
    return (
      <>
        {header}
        <Alert severity="error">{loadErrorMessage(error)}</Alert>
      </>
    );
  }
  if (isLoading || !data) {
    return (
      <>
        {header}
        <Skeleton variant="rounded" height={360} />
      </>
    );
  }

  const { accounts, catalog, providers, orders, delivery, cod } = data;
  const etb = (minor: number) => currency(fromMinorUnits(minor));

  return (
    <>
      {header}

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard label="Accounts" value={compactNumber(accounts.total)} icon={PeopleRoundedIcon} />
        </Grid>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard
            label="Pharmacies (can transact / total)"
            value={`${compactNumber(providers.pharmacies.eligible)} / ${compactNumber(providers.pharmacies.total)}`}
            icon={StorefrontRoundedIcon}
          />
        </Grid>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard label="Orders" value={compactNumber(orders.orders.total)} icon={ReceiptLongRoundedIcon} />
        </Grid>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard
            label="Drivers (dispatchable / total)"
            value={`${compactNumber(delivery.drivers.dispatchable)} / ${compactNumber(delivery.drivers.total)}`}
            icon={LocalShippingRoundedIcon}
          />
        </Grid>
      </Grid>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} md={6}>
          <Breakdown title="Orders by status" data={toChartData(orders.orders.byStatus)} color={theme.palette.primary.main} />
        </Grid>
        <Grid item xs={12} md={6}>
          <Breakdown title="Fulfillments by status" data={toChartData(orders.fulfillments.byStatus)} color={theme.palette.secondary.main} />
        </Grid>
        <Grid item xs={12} md={6}>
          <Breakdown title="Pharmacies by transacting status" kind="pie" data={toChartData(providers.pharmacies.byTransactingStatus)} color={theme.palette.primary.main} />
        </Grid>
        <Grid item xs={12} md={6}>
          <Breakdown title="Pharmacy licences" kind="pie" data={toChartData(providers.pharmacies.byLicenseStatus)} color={theme.palette.primary.main} />
        </Grid>
        <Grid item xs={12} md={6}>
          <Breakdown title="Delivery jobs by status" data={toChartData(delivery.jobs.byStatus)} color={theme.palette.info.main} />
        </Grid>
        <Grid item xs={12} md={6}>
          <Breakdown title="Catalogue products by status" data={toChartData(catalog.products.byStatus)} color={theme.palette.success.main} />
        </Grid>
        <Grid item xs={12} md={6}>
          <Breakdown title="Accounts by status" kind="pie" data={toChartData(accounts.byStatus)} color={theme.palette.primary.main} />
        </Grid>
        <Grid item xs={12} md={6}>
          <Breakdown
            title="Accounts by primary role"
            data={toChartData(accounts.byPrimaryRole.map((r) => ({ status: r.primaryRole, count: r.count })))}
            color={theme.palette.warning.main}
          />
        </Grid>
      </Grid>

      <Typography variant="h6" sx={{ mb: 1 }}>
        Cash on delivery
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard label={`Expected (${cod.count} collections)`} value={etb(cod.expectedAmount)} />
        </Grid>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard label="Collected" value={etb(cod.collectedAmount)} />
        </Grid>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard label="Remitted" value={etb(cod.remittedAmount)} />
        </Grid>
        <Grid item xs={12} sm={6} lg={3}>
          <StatCard
            label={`Outstanding (${cod.outstandingCount}); discrepancies ${cod.discrepancyCount}`}
            value={etb(cod.outstandingAmount)}
          />
        </Grid>
      </Grid>
    </>
  );
}

export function AdminDashboardPage() {
  return <AdminOverviewPage title="Dashboard" />;
}

export function AdminAnalyticsPage() {
  return <AdminOverviewPage title="Analytics" />;
}
