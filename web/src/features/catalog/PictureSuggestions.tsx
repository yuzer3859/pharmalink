import { useState } from 'react';
import { Alert, Box, Button, Card, CardContent, CardMedia, Pagination, Skeleton, Stack, TextField, Typography } from '@mui/material';
import { useDecidePictureSuggestion, usePictureSuggestions } from '@/hooks/useAdminCatalog';
import {
  catalogErrorMessage,
  isValidPictureRejectReason,
  MAX_PICTURES,
  PICTURE_REJECT_REASON_MAX,
  PICTURE_REJECT_REASON_MIN,
  pictureSrc,
  type PictureSuggestionReviewItem,
} from '@/services/adminCatalog.service';
import { formatDateTime } from '@/utils/format';

const PAGE_SIZE = 6;

function SuggestionCard({ item }: { item: PictureSuggestionReviewItem }) {
  const decide = useDecidePictureSuggestion();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const src = pictureSrc(item.imageUrl);
  const full = item.productPictureCount >= MAX_PICTURES;

  return (
    <Card variant="outlined" data-testid="suggestion-card" sx={{ display: 'flex', flexDirection: 'column' }}>
      {src ? <CardMedia component="img" image={src} alt={`Suggested picture of ${item.productName ?? 'the product'}`} sx={{ aspectRatio: '1 / 1', objectFit: 'contain', bgcolor: 'action.hover' }} /> : null}
      <CardContent sx={{ flex: 1 }}>
        <Stack spacing={0.5}>
          <Typography variant="subtitle2">{item.productName ?? 'Unnamed product'}</Typography>
          <Typography variant="body2" color="text.secondary">
            From {item.pharmacyName ?? 'a pharmacy'} · {formatDateTime(item.createdAt)}
          </Typography>
          <Typography variant="caption" color={full ? 'error' : 'text.secondary'}>
            {full
              ? `The product already has ${MAX_PICTURES} pictures. Remove one before approving.`
              : `The product has ${item.productPictureCount} picture${item.productPictureCount === 1 ? '' : 's'}; this one is added last.`}
          </Typography>
        </Stack>
        {rejecting ? (
          <Stack spacing={1} sx={{ mt: 1.5 }}>
            <TextField
              size="small"
              multiline
              minRows={2}
              autoFocus
              label="Why not? (the pharmacy sees this)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              helperText={`${PICTURE_REJECT_REASON_MIN}–${PICTURE_REJECT_REASON_MAX} characters.`}
              inputProps={{ maxLength: PICTURE_REJECT_REASON_MAX }}
            />
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                color="error"
                disabled={!isValidPictureRejectReason(reason) || decide.isPending}
                onClick={() => decide.mutate({ id: item.id, approve: false, reason })}
              >
                Turn down
              </Button>
              <Button disabled={decide.isPending} onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button variant="contained" color="success" disabled={full || decide.isPending} onClick={() => decide.mutate({ id: item.id, approve: true })}>
              Approve
            </Button>
            <Button variant="outlined" color="error" disabled={decide.isPending} onClick={() => setRejecting(true)}>
              Turn down
            </Button>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Work 151: pictures pharmacies suggested for products they stock, oldest first. Approving adds
 * the picture to the product (customers see it at once); turning it down tells the pharmacy why.
 */
export function PictureSuggestions() {
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = usePictureSuggestions({ status: 'PENDING', page, size: PAGE_SIZE });
  const total = data?.meta.total ?? 0;

  return (
    <Box component="section" aria-label="Pictures from pharmacies" sx={{ mb: 3 }}>
      <Typography variant="h6" sx={{ mb: 0.5 }}>
        Pictures from pharmacies{total > 0 ? ` (${total})` : ''}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Pharmacies suggest pictures for products they stock. Customers see one only after you approve it.
      </Typography>
      {error ? <Alert severity="error">{catalogErrorMessage(error, 'The suggested pictures could not be loaded.')}</Alert> : null}
      {isLoading ? <Skeleton variant="rounded" height={120} /> : null}
      {data && data.items.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No pictures waiting.
        </Typography>
      ) : null}
      {data && data.items.length > 0 ? (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {data.items.map((item) => (
            <SuggestionCard key={item.id} item={item} />
          ))}
        </Box>
      ) : null}
      {total > PAGE_SIZE ? <Pagination sx={{ mt: 1.5 }} count={Math.ceil(total / PAGE_SIZE)} page={page} onChange={(_e, p) => setPage(p)} /> : null}
    </Box>
  );
}
