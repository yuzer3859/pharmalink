import { useState } from 'react';
import { Alert, Box, Button, Grid, Skeleton, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChartCard } from '@/components/charts/ChartCard';
import { TrendLineChart } from '@/components/charts/Charts';
import { EmptyState } from '@/components/common/EmptyState';
import { adminAnalyticsService, hasAnyPoint, rangeStart, toTrendData } from '@/services/adminAnalytics.service';
import { ApiError } from '@/services/apiClient';
import { TRENDS, type TrendDef } from './analyticsTrends.config';

const RANGES = [7, 30, 90] as const;

function TrendChart({ def, days }: { def: TrendDef; days: number }) {
  const theme = useTheme();
  const metrics = def.lines.map((l) => l.metric);
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-analytics', 'timeseries', metrics, days] as const,
    queryFn: () => adminAnalyticsService.timeseries(metrics, { from: rangeStart(days) }),
  });
  return (
    <ChartCard title={def.title} subheader={def.subheader} height={260}>
      {error ? (
        <Alert severity="error">{error instanceof ApiError ? error.message : 'The trend could not be loaded.'}</Alert>
      ) : isLoading || !data ? (
        <Skeleton variant="rounded" height={240} />
      ) : !hasAnyPoint(data) ? (
        <EmptyState title="No snapshots yet" description="Daily snapshots start once the server has run; take one now to begin." />
      ) : (
        <TrendLineChart
          data={toTrendData(data, metrics, def.scale)}
          series={def.lines.map((l, k) => ({ key: `s${k}`, label: l.label, color: theme.palette[l.color].main }))}
        />
      )}
    </ChartCard>
  );
}

/**
 * Trends from daily snapshots (Work 87, `GET /admin/analytics/timeseries`). One value per metric per
 * UTC day — the last snapshot of that day; a day without one is a gap in the line, never a zero.
 */
export function AnalyticsTrends() {
  const [days, setDays] = useState<number>(30);
  const queryClient = useQueryClient();
  const snapshot = useMutation({
    mutationFn: () => adminAnalyticsService.snapshotNow(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-analytics', 'timeseries'] }),
  });

  return (
    <Box sx={{ mt: 3 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} justifyContent="space-between" sx={{ mb: 1 }}>
        <Typography variant="h6">Trends</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <ToggleButtonGroup size="small" exclusive value={days} onChange={(_, v: number | null) => v && setDays(v)} aria-label="Range">
            {RANGES.map((r) => (
              <ToggleButton key={r} value={r}>
                {r} days
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Button size="small" variant="outlined" onClick={() => snapshot.mutate()} disabled={snapshot.isPending}>
            Snapshot now
          </Button>
        </Stack>
      </Stack>
      {snapshot.isSuccess && (
        <Alert severity="success" sx={{ mb: 1 }}>
          Snapshot for {snapshot.data.day} saved ({snapshot.data.metrics} figures).
        </Alert>
      )}
      {snapshot.isError && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {snapshot.error instanceof ApiError ? snapshot.error.message : 'The snapshot could not be taken.'}
        </Alert>
      )}
      <Grid container spacing={2}>
        {TRENDS.map((def) => (
          <Grid item xs={12} md={6} key={def.title}>
            <TrendChart def={def} days={days} />
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
