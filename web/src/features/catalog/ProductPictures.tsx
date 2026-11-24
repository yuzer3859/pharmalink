import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, IconButton, Skeleton, Stack, Tooltip, Typography } from '@mui/material';
import AddPhotoAlternateRoundedIcon from '@mui/icons-material/AddPhotoAlternateRounded';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import { useCatalogPictures, useSavePictures } from '@/hooks/useAdminCatalog';
import {
  adminCatalogService,
  catalogErrorMessage,
  MAX_PICTURES,
  movePicture,
  pictureProblem,
  pictureSrc,
  PICTURE_TYPES,
} from '@/services/adminCatalog.service';

/**
 * Work 150: a product's pictures, as customers see them. Staff upload JPEG, PNG or WebP files
 * (each goes straight to storage), put them in order, choose the main one (the first) and remove
 * any; nothing changes for customers until Save.
 */
export function ProductPictures({ productId }: { productId: string }) {
  const saved = useCatalogPictures(productId);
  const save = useSavePictures();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [uploading, setUploading] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(null), [saved.data]);
  const list = draft ?? saved.data ?? [];
  const changed = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved.data ?? []);

  async function addFiles(files: FileList | null) {
    setProblem(null);
    const chosen = Array.from(files ?? []);
    if (input.current) input.current.value = '';
    const room = MAX_PICTURES - list.length;
    if (chosen.length > room) {
      setProblem(`A product can have at most ${MAX_PICTURES} pictures.`);
      return;
    }
    for (const file of chosen) {
      const why = pictureProblem(file);
      if (why) {
        setProblem(`${file.name}: ${why}`);
        return;
      }
    }
    setUploading(chosen.length);
    let next = [...list];
    try {
      for (const file of chosen) {
        next = [...next, await adminCatalogService.uploadPicture(productId, file)];
        setDraft(next);
        setUploading((n) => n - 1);
      }
    } catch (error) {
      setProblem(catalogErrorMessage(error, 'The picture could not be uploaded.'));
    } finally {
      setUploading(0);
    }
  }

  return (
    <Stack spacing={1.25} aria-label="Pictures" component="section">
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="subtitle2">Pictures</Typography>
        <Button
          size="small"
          startIcon={uploading ? <CircularProgress size={14} /> : <AddPhotoAlternateRoundedIcon />}
          disabled={uploading > 0 || list.length >= MAX_PICTURES}
          onClick={() => input.current?.click()}
        >
          {uploading ? 'Uploading…' : 'Add pictures'}
        </Button>
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept={PICTURE_TYPES.join(',')}
          aria-label="Picture files"
          data-testid="picture-input"
          onChange={(e) => addFiles(e.target.files)}
        />
      </Stack>

      {saved.error ? <Alert severity="error">{catalogErrorMessage(saved.error, 'The pictures could not be loaded.')}</Alert> : null}
      {saved.isLoading ? <Skeleton variant="rounded" height={96} /> : null}
      {saved.data && list.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No pictures yet. Customers see a placeholder until one is added.
        </Typography>
      ) : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 1 }}>
        {list.map((url, i) => {
          const src = pictureSrc(url);
          return (
            <Box
              key={url}
              data-testid="picture"
              sx={{ position: 'relative', borderRadius: 2, overflow: 'hidden', border: 2, borderColor: i === 0 ? 'primary.main' : 'divider', bgcolor: 'action.hover' }}
            >
              <Box sx={{ aspectRatio: '1 / 1', display: 'grid', placeItems: 'center' }}>
                {src ? <Box component="img" src={src} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Typography variant="caption">—</Typography>}
              </Box>
              {i === 0 ? <Chip label="Main" color="primary" size="small" sx={{ position: 'absolute', top: 4, left: 4, height: 20 }} /> : null}
              <Stack direction="row" justifyContent="space-between" sx={{ bgcolor: 'background.paper', px: 0.25 }}>
                <IconButton size="small" aria-label="Move earlier" disabled={i === 0} onClick={() => setDraft(movePicture(list, i, i - 1))}>
                  <ChevronLeftRoundedIcon fontSize="small" />
                </IconButton>
                {i !== 0 ? (
                  <Tooltip title="Make main picture">
                    <IconButton size="small" aria-label="Make main picture" onClick={() => setDraft(movePicture(list, i, 0))}>
                      <StarRoundedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                ) : null}
                <IconButton size="small" aria-label="Remove picture" onClick={() => setDraft(list.filter((_, j) => j !== i))}>
                  <DeleteOutlineRoundedIcon fontSize="small" />
                </IconButton>
                <IconButton size="small" aria-label="Move later" disabled={i === list.length - 1} onClick={() => setDraft(movePicture(list, i, i + 1))}>
                  <ChevronRightRoundedIcon fontSize="small" />
                </IconButton>
              </Stack>
            </Box>
          );
        })}
      </Box>

      {problem ? <Alert severity="warning" onClose={() => setProblem(null)}>{problem}</Alert> : null}
      {changed ? (
        <Stack direction="row" spacing={1}>
          <Button variant="contained" disabled={save.isPending || uploading > 0} onClick={() => save.mutate({ id: productId, images: list })}>
            Save pictures
          </Button>
          <Button disabled={save.isPending} onClick={() => setDraft(null)}>
            Discard changes
          </Button>
        </Stack>
      ) : null}
      <Typography variant="caption" color="text.secondary">
        JPEG, PNG or WebP, up to 5 MB each, at most {MAX_PICTURES}. The first is the main picture.
      </Typography>
    </Stack>
  );
}
