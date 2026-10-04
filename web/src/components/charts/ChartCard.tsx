import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader } from '@mui/material';

interface ChartCardProps {
  title: string;
  subheader?: string;
  action?: ReactNode;
  height?: number;
  children: ReactNode;
}

export function ChartCard({ title, subheader, action, height = 300, children }: ChartCardProps) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardHeader
        title={title}
        subheader={subheader}
        action={action}
        titleTypographyProps={{ variant: 'h6' }}
      />
      <CardContent sx={{ height, pt: 0 }}>{children}</CardContent>
    </Card>
  );
}
