import type { ComponentType } from 'react';
import { Avatar, Box, Card, CardContent, Stack, Typography, alpha, useTheme } from '@mui/material';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded';

interface StatCardProps {
  label: string;
  value: string;
  deltaPct?: number;
  icon?: ComponentType;
  accent?: string;
}

export function StatCard({ label, value, deltaPct, icon: Icon, accent }: StatCardProps) {
  const theme = useTheme();
  const color = accent ?? theme.palette.primary.main;
  const positive = (deltaPct ?? 0) >= 0;

  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box>
            <Typography variant="body2" color="text.secondary" fontWeight={600}>
              {label}
            </Typography>
            <Typography variant="h5" sx={{ mt: 0.75 }}>
              {value}
            </Typography>
          </Box>
          {Icon && (
            <Avatar
              variant="rounded"
              sx={{ bgcolor: alpha(color, 0.12), color, width: 44, height: 44 }}
            >
              <Icon />
            </Avatar>
          )}
        </Stack>
        {deltaPct !== undefined && (
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 1.5 }}>
            {positive ? (
              <ArrowUpwardRoundedIcon sx={{ fontSize: 16, color: 'success.main' }} />
            ) : (
              <ArrowDownwardRoundedIcon sx={{ fontSize: 16, color: 'error.main' }} />
            )}
            <Typography
              variant="caption"
              fontWeight={700}
              color={positive ? 'success.main' : 'error.main'}
            >
              {Math.abs(deltaPct).toFixed(1)}%
            </Typography>
            <Typography variant="caption" color="text.secondary">
              vs last period
            </Typography>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}
