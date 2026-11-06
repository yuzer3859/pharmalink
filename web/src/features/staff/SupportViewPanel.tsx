import { useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StatusChip } from '@/components/common/StatusChip';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import { approvalErrorMessage } from '@/services/adminApprovals.service';
import { gatedMessage } from '@/services/settlementPayout.service';
import { supportViewService, type SupportViewSnapshot } from '@/services/supportView.service';
import { formatDateTime } from '@/utils/format';

/**
 * Support "view as" on an account (Work 85, `support:impersonate:any`). Ask with a reason → a different
 * administrator approves on the Approvals page → start it here and see the account read-only, as its
 * holder does, for up to 15 minutes. The holder is notified; every read is audited.
 */
export function SupportViewPanel({ userId }: { userId: string }) {
  const { can } = useAuth();
  const notify = useNotify();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [view, setView] = useState<{ sessionId: string; expiresAt: number; snapshot: SupportViewSnapshot } | null>(null);
  const enabled = can('support:impersonate');
  const sessions = useQuery({
    queryKey: ['support-view', userId] as const,
    queryFn: () => supportViewService.sessions(userId),
    enabled,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['support-view', userId] });
  const ask = useMutation({
    mutationFn: () => supportViewService.request(userId, reason),
    onSuccess: (r) => {
      refresh();
      qc.invalidateQueries({ queryKey: ['admin-approvals'] });
      setReason('');
      notify(gatedMessage(r, 'Support view authorized.', 'administrator'));
    },
    onError: (e) => notify(approvalErrorMessage(e, 'The support view could not be requested.'), 'error'),
  });
  const start = useMutation({
    mutationFn: async (sessionId: string) => {
      const token = await supportViewService.start(sessionId);
      return { sessionId, expiresAt: token.expiresAt, snapshot: await supportViewService.snapshot(token.accessToken) };
    },
    onSuccess: (v) => {
      refresh();
      setView(v);
    },
    onError: (e) => notify(approvalErrorMessage(e, 'The support view could not be started.'), 'error'),
  });
  const end = useMutation({
    mutationFn: (sessionId: string) => supportViewService.end(sessionId),
    onSuccess: () => {
      refresh();
      setView(null);
      notify('Support view ended.');
    },
    onError: (e) => notify(approvalErrorMessage(e, 'The support view could not be ended.'), 'error'),
  });

  if (!enabled) return null;
  const mine = sessions.data?.items ?? [];
  return (
    <>
      <Divider />
      <Typography variant="subtitle2">Support view (read-only)</Typography>
      <TextField
        size="small"
        multiline
        minRows={2}
        label="Why do you need to see this account? (audited)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        inputProps={{ maxLength: 500 }}
      />
      <Button size="small" variant="outlined" disabled={reason.trim().length < 5 || ask.isPending} onClick={() => ask.mutate()}>
        Request support view
      </Button>
      {mine.map((s) => (
        <Stack key={s.id} direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
          <Box>
            <StatusChip status={s.status.toLowerCase()} />
            <Typography variant="caption" display="block" color="text.secondary">
              {s.status === 'AUTHORIZED' ? `Start before ${formatDateTime(s.redeemBy)}` : s.expiresAt ? `Until ${formatDateTime(s.expiresAt)}` : formatDateTime(s.redeemBy)}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            {s.status === 'AUTHORIZED' ? (
              <Button size="small" disabled={start.isPending} onClick={() => start.mutate(s.id)}>
                Start
              </Button>
            ) : null}
            {s.status === 'AUTHORIZED' || s.status === 'ACTIVE' ? (
              <Button size="small" color="error" disabled={end.isPending} onClick={() => end.mutate(s.id)}>
                End
              </Button>
            ) : null}
          </Stack>
        </Stack>
      ))}
      <Dialog open={!!view} onClose={() => setView(null)} fullWidth maxWidth="sm">
        <DialogTitle>Account as its holder sees it</DialogTitle>
        <DialogContent>
          {view ? (
            <Stack spacing={1}>
              <Alert severity="warning">Read-only until {formatDateTime(new Date(view.expiresAt * 1000).toISOString())}. Nothing can be changed.</Alert>
              <Typography variant="subtitle2">Profile</Typography>
              <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(view.snapshot.me, null, 2)}
              </Box>
              <Typography variant="subtitle2">Recent orders ({view.snapshot.orders?.total ?? 0})</Typography>
              <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(view.snapshot.orders?.items ?? [], null, 2)}
              </Box>
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          {view ? (
            <Button color="error" onClick={() => end.mutate(view.sessionId)}>
              End support view
            </Button>
          ) : null}
          <Button onClick={() => setView(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
