import { useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { useAuth } from '@/context/AuthContext';
import { usePortal } from '@/hooks/usePortal';
import {
  adminModerationService,
  movesFor,
  portalPathFor,
  SOURCE_LABELS,
  type ModerationMove,
  type ModerationReview,
  type ReviewStatus,
} from '@/services/adminModeration.service';
import { ApiError } from '@/services/apiClient';
import { formatDateTime } from '@/utils/format';

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}` : fallback;

const MOVE_LABEL: Record<ModerationMove, string> = { hide: 'Hide', remove: 'Remove', restore: 'Restore' };

function MoveDialog({ review, move, onClose }: { review: ModerationReview; move: ModerationMove; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: () => adminModerationService.moderate(review.reviewId, move, reason),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-moderation'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{MOVE_LABEL[move]} this review</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {review.rating}★ {review.title ?? ''} {review.body ?? ''}
        </Typography>
        <TextField
          label="Reason (kept in the moderation log, not shown to the author)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          fullWidth
          multiline
          minRows={2}
          inputProps={{ maxLength: 500 }}
        />
        {act.isError ? <Alert severity="error" sx={{ mt: 1 }}>{errorText(act.error, 'The review could not be moderated.')}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" color={move === 'restore' ? 'primary' : 'warning'} disabled={reason.trim().length < 3 || act.isPending} onClick={() => act.mutate()}>
          {MOVE_LABEL[move]}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Moderation (Work 91, `review:moderate:any`): the unified flagged-content view (reviews held by
 * reports or rules, catalogue products awaiting review, open content disputes) and the review queue
 * with hide, remove and restore. Every decision is logged and audited; the author is told.
 */
export function ModerationPage() {
  const portal = usePortal();
  const { can } = useAuth();
  const allowed = can('reviews:moderate');
  const [status, setStatus] = useState<ReviewStatus | 'attention'>('attention');
  const [acting, setActing] = useState<{ review: ModerationReview; move: ModerationMove } | null>(null);

  const flagged = useQuery({ queryKey: ['admin-moderation', 'flagged'], queryFn: () => adminModerationService.flagged(), enabled: allowed });
  const reviews = useQuery({
    queryKey: ['admin-moderation', 'reviews', status],
    queryFn: () => adminModerationService.reviews(status === 'attention' ? { needsAttention: true } : { status }),
    enabled: allowed,
  });

  const header = <PageHeader portalName={portal.title} title="Moderation" subtitle="Flagged content from every source, and the review queue." />;
  if (!allowed) {
    return (
      <>
        {header}
        <Alert severity="info">Moderation needs the review:moderate:any permission.</Alert>
      </>
    );
  }

  return (
    <>
      {header}
      <Typography variant="h6" sx={{ mb: 1 }}>
        Flagged content
      </Typography>
      {flagged.error ? (
        <Alert severity="error">{errorText(flagged.error, 'Flagged content could not be loaded.')}</Alert>
      ) : !flagged.data ? (
        <Skeleton variant="rounded" height={160} />
      ) : (
        <>
          <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap">
            {(Object.keys(SOURCE_LABELS) as Array<keyof typeof SOURCE_LABELS>).map((s) => (
              <Chip key={s} label={`${SOURCE_LABELS[s]}: ${flagged.data.totals[s]}`} />
            ))}
          </Stack>
          {flagged.data.items.length === 0 ? (
            <EmptyState title="Nothing flagged" description="No content is awaiting a decision." />
          ) : (
            <TableContainer component={Paper} sx={{ mb: 3 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Source</TableCell>
                    <TableCell>Item</TableCell>
                    <TableCell>Why</TableCell>
                    <TableCell>Since</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {flagged.data.items.map((item) => (
                    <TableRow key={`${item.source}-${item.id}`}>
                      <TableCell>{SOURCE_LABELS[item.source]}</TableCell>
                      <TableCell>{item.summary}</TableCell>
                      <TableCell>{item.reasons.map((r) => r.replace(/_/g, ' ').toLowerCase()).join(', ')}</TableCell>
                      <TableCell>{formatDateTime(item.since)}</TableCell>
                      <TableCell>
                        <Button size="small" component={RouterLink} to={`${portal.basePath}/${portalPathFor(item)}`}>
                          Open queue
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}

      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Typography variant="h6">Reviews</Typography>
        <TextField select size="small" label="Show" value={status} onChange={(e) => setStatus(e.target.value as ReviewStatus | 'attention')} sx={{ minWidth: 200 }}>
          <MenuItem value="attention">Needs attention</MenuItem>
          {(['PUBLISHED', 'FLAGGED', 'HIDDEN', 'REMOVED'] as ReviewStatus[]).map((s) => (
            <MenuItem key={s} value={s}>
              {s.toLowerCase()}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      {reviews.error ? (
        <Alert severity="error">{errorText(reviews.error, 'Reviews could not be loaded.')}</Alert>
      ) : !reviews.data ? (
        <Skeleton variant="rounded" height={200} />
      ) : reviews.data.items.length === 0 ? (
        <EmptyState title="No reviews" description="Nothing matches this filter." />
      ) : (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Review</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Reports</TableCell>
                <TableCell>Updated</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {reviews.data.items.map((r) => (
                <TableRow key={r.reviewId}>
                  <TableCell sx={{ maxWidth: 420 }}>
                    <Typography variant="body2">
                      {r.rating}★ {r.title ?? ''}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {r.body ?? ''}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={r.status.toLowerCase()} color={r.status === 'FLAGGED' ? 'warning' : r.status === 'PUBLISHED' ? 'success' : 'default'} />
                    {r.autoFlags.length ? <Typography variant="caption" display="block">rules: {r.autoFlags.join(', ').toLowerCase()}</Typography> : null}
                  </TableCell>
                  <TableCell>{r.openReportCount ? `${r.openReportCount} (${r.reportReasons.join(', ').toLowerCase()})` : '—'}</TableCell>
                  <TableCell>{formatDateTime(r.updatedAt)}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1}>
                      {movesFor(r.status).map((move) => (
                        <Button key={move} size="small" variant="outlined" onClick={() => setActing({ review: r, move })}>
                          {MOVE_LABEL[move]}
                        </Button>
                      ))}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {acting ? <MoveDialog review={acting.review} move={acting.move} onClose={() => setActing(null)} /> : null}
    </>
  );
}
