import type { ReactNode } from 'react';
import { Box, Breadcrumbs, Link, Stack, Typography } from '@mui/material';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  portalName?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, portalName, actions }: PageHeaderProps) {
  return (
    <Box sx={{ mb: 3 }}>
      {portalName && (
        <Breadcrumbs sx={{ mb: 0.5 }}>
          <Link underline="hover" color="inherit" href="#">
            {portalName}
          </Link>
          <Typography color="text.primary" variant="body2">
            {title}
          </Typography>
        </Breadcrumbs>
      )}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        spacing={2}
      >
        <Box>
          <Typography variant="h4">{title}</Typography>
          {subtitle && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        {actions && <Stack direction="row" spacing={1.5}>{actions}</Stack>}
      </Stack>
    </Box>
  );
}
