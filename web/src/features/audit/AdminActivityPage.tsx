import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  Drawer,
  IconButton,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  Paper,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import { adminActivityService, RULE_LABELS, WINDOWS, windowFor, type StaffActivity } from '@/services/adminActivity.service';
import { ApiError } from '@/services/apiClient';
import { formatDateTime } from '@/utils/format';

const errorText = (error: unknown) =>
  error instanceof ApiError
    ? error.status === 403
      ? 'Admin activity monitoring is for Super Admins only.'
      : `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`
    : 'Admin activity could not be loaded.';

const who = (s: StaffActivity) => s.email ?? s.phone ?? s.userId;

function EntriesDrawer({ member, range, onClose }: { member: StaffActivity; range: { from: string; to: string }; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-activity', 'entries', member.userId, range] as const,
    queryFn: () => adminActivityService.entries(member.userId, { ...range, size: 100 }),
  });
  return (
    <Drawer anchor="right" open onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 560 } } }}>
      <Box sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">{who(member)}</Typography>
          <IconButton onClick={onClose} aria-label="Close">
            <CloseRoundedIcon />
          </IconButton>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {member.roles.join(', ')} · {member.total} actions · {member.distinctIps} IP addresses
        </Typography>
        {member.flags.map((f) => (
          <Alert key={f.rule} severity="warning" sx={{ mb: 1 }}>
            <strong>{RULE_LABELS[f.rule].label}</strong> ({f.count}) since {formatDateTime(f.firstAt)}. {RULE_LABELS[f.rule].help} Example
            entries: {f.exampleIds.join(', ')}
          </Alert>
        ))}
        <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
          By action
        </Typography>
        <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mb: 2 }}>
          {member.byAction.map((a) => (
            <Chip key={a.action} size="small" label={`${a.action} · ${a.count}`} />
          ))}
        </Stack>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Latest entries
        </Typography>
        {error ? (
          <Alert severity="error">{errorText(error)}</Alert>
        ) : isLoading || !data ? (
          <Skeleton variant="rounded" height={200} />
        ) : data.items.length === 0 ? (
          <EmptyState title="No entries" description="Nothing recorded in this window." />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Time</TableCell>
                <TableCell>Action</TableCell>
                <TableCell>Resource</TableCell>
                <TableCell>IP</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell>{e.action}</TableCell>
                  <TableCell>
                    {e.resourceType}
                    {e.resourceId ? ` ${e.resourceId}` : ''}
                  </TableCell>
                  <TableCell>{e.ip ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {data && data.total > data.items.length && (
          <Typography variant="caption" color="text.secondary">
            Showing the latest {data.items.length} of {data.total}; the Audit Logs page has the rest.
          </Typography>
        )}
      </Box>
    </Drawer>
  );
}

/**
 * Admin activity and anomaly monitoring (Work 88, `GET /admin/admins/activity`, Super Admin only):
 * every holder of a platform role, their audited actions in the window, and rule-based flags.
 * A flag is a prompt to look, not a verdict; nothing happens automatically.
 */
export function AdminActivityPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const allowed = can('staff:monitor');
  const [hours, setHours] = useState<number>(WINDOWS[1].hours);
  const [selected, setSelected] = useState<StaffActivity | null>(null);
  // Fixed per choice, so the query key is stable between renders.
  const range = useMemo(() => windowFor(hours), [hours]);
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-activity', 'report', range] as const,
    queryFn: () => adminActivityService.report(range),
    enabled: allowed,
  });

  const header = (
    <PageHeader
      portalName={portal.title}
      title="Admin activity"
      subtitle="Who did what, from the audit trail, with anomaly flags. Every view of this page is itself audited."
    />
  );
  if (!allowed) {
    return (
      <>
        {header}
        <Alert severity="info">Admin activity monitoring is for Super Admins only.</Alert>
      </>
    );
  }

  return (
    <>
      {header}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <ToggleButtonGroup size="small" exclusive value={hours} onChange={(_, v: number | null) => v && setHours(v)} aria-label="Window">
          {WINDOWS.map((w) => (
            <ToggleButton key={w.hours} value={w.hours}>
              {w.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Stack>
      {error ? (
        <Alert severity="error">{errorText(error)}</Alert>
      ) : isLoading || !data ? (
        <Skeleton variant="rounded" height={320} />
      ) : (
        <>
          {data.truncated && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              More entries than one read covers: counts are partial. Choose a shorter window.
            </Alert>
          )}
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Staff member</TableCell>
                  <TableCell>Roles</TableCell>
                  <TableCell align="right">Actions</TableCell>
                  <TableCell>Last active</TableCell>
                  <TableCell align="right">IPs</TableCell>
                  <TableCell>Flags</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.staff.map((s) => (
                  <TableRow key={s.userId} hover onClick={() => setSelected(s)} sx={{ cursor: 'pointer' }}>
                    <TableCell>{who(s)}</TableCell>
                    <TableCell>{s.roles.join(', ')}</TableCell>
                    <TableCell align="right">{s.total}</TableCell>
                    <TableCell>{s.lastAt ? formatDateTime(s.lastAt) : '—'}</TableCell>
                    <TableCell align="right">{s.distinctIps}</TableCell>
                    <TableCell>
                      <Stack direction="row" flexWrap="wrap" gap={0.5}>
                        {s.flags.map((f) => (
                          <Tooltip key={f.rule} title={RULE_LABELS[f.rule].help}>
                            <Chip size="small" color="warning" label={`${RULE_LABELS[f.rule].label} · ${f.count}`} />
                          </Tooltip>
                        ))}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
      {selected && <EntriesDrawer member={selected} range={range} onClose={() => setSelected(null)} />}
    </>
  );
}
