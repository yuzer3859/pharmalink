import { useRef } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Skeleton, Stack, Typography } from '@mui/material';
import AddPhotoAlternateRoundedIcon from '@mui/icons-material/AddPhotoAlternateRounded';
import { inventoryErrorMessage, useListingPictures, useSuggestPicture } from '@/hooks/usePharmacyInventory';
import { PICTURE_TYPES, pictureSrc, type PictureSuggestionStatus } from '@/services/adminCatalog.service';
import { MAX_WAITING_SUGGESTIONS } from '@/services/pharmacyInventory.service';
import { formatDate } from '@/utils/format';

const STATUS: Record<PictureSuggestionStatus, { label: string; color: 'warning' | 'success' | 'error' }> = {
  PENDING: { label: 'Waiting for review', color: 'warning' },
  APPROVED: { label: 'Approved', color: 'success' },
  REJECTED: { label: 'Not approved', color: 'error' },
};

function Thumb({ url, main }: { url: string; main?: boolean }) {
  const src = pictureSrc(url);
  return (
    <Box sx={{ position: 'relative', aspectRatio: '1 / 1', borderRadius: 2, overflow: 'hidden', border: 2, borderColor: main ? 'primary.main' : 'divider', bgcolor: 'action.hover' }}>
      {src ? <Box component="img" src={src} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
      {main ? <Chip label="Main" color="primary" size="small" sx={{ position: 'absolute', top: 4, left: 4, height: 20 }} /> : null}
    </Box>
  );
}

/**
 * Work 151 (owner decision 2026-11-24): the product's pictures as customers see them, and the
 * pharmacy's own suggestions. Pictures are shared by every pharmacy that stocks the product, so a
 * new one goes to catalogue staff first; customers see it once they approve it.
 */
export function ListingPictures({ listingId }: { listingId: string }) {
  const pictures = useListingPictures(listingId);
  const suggest = useSuggestPicture(listingId);
  const input = useRef<HTMLInputElement>(null);
  const waiting = pictures.data?.suggestions.filter((s) => s.status === 'PENDING').length ?? 0;
  const full = waiting >= MAX_WAITING_SUGGESTIONS;

  return (
    <Stack spacing={1.25} component="section" aria-label="Pictures">
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="subtitle2">Pictures customers see</Typography>
        <Button
          size="small"
          startIcon={suggest.isPending ? <CircularProgress size={14} /> : <AddPhotoAlternateRoundedIcon />}
          disabled={suggest.isPending || !pictures.data || full}
          onClick={() => input.current?.click()}
        >
          {suggest.isPending ? 'Sending…' : 'Suggest a picture'}
        </Button>
        <input
          ref={input}
          type="file"
          hidden
          accept={PICTURE_TYPES.join(',')}
          aria-label="Picture file"
          data-testid="suggest-picture-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) suggest.mutate(file);
          }}
        />
      </Stack>

      {pictures.error ? <Alert severity="error">{inventoryErrorMessage(pictures.error, 'The pictures could not be loaded.')}</Alert> : null}
      {pictures.isLoading ? <Skeleton variant="rounded" height={96} /> : null}
      {pictures.data ? (
        pictures.data.images.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No pictures yet. Customers see a placeholder; suggest one so they can recognise the product.
          </Typography>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 1 }}>
            {pictures.data.images.map((url, i) => (
              <Thumb key={url} url={url} main={i === 0} />
            ))}
          </Box>
        )
      ) : null}

      {pictures.data && pictures.data.suggestions.length > 0 ? (
        <>
          <Typography variant="subtitle2" sx={{ pt: 0.5 }}>
            Your suggestions
          </Typography>
          {pictures.data.suggestions.map((s) => (
            <Stack key={s.id} direction="row" spacing={1.5} alignItems="center" data-testid="picture-suggestion">
              <Box sx={{ width: 56, flexShrink: 0 }}>
                <Thumb url={s.imageUrl} />
              </Box>
              <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" label={STATUS[s.status].label} color={STATUS[s.status].color} variant="outlined" />
                  <Typography variant="caption" color="text.secondary">
                    {formatDate(s.createdAt)}
                  </Typography>
                </Stack>
                {s.reason ? (
                  <Typography variant="body2" color="text.secondary">
                    {s.reason}
                  </Typography>
                ) : null}
              </Stack>
            </Stack>
          ))}
        </>
      ) : null}

      <Typography variant="caption" color="text.secondary">
        {full
          ? `You have ${MAX_WAITING_SUGGESTIONS} pictures waiting. You can suggest more once they are reviewed.`
          : 'JPEG, PNG or WebP, up to 5 MB. A clear photo of the pack, without people. Catalogue staff review it before customers see it.'}
      </Typography>
    </Stack>
  );
}
