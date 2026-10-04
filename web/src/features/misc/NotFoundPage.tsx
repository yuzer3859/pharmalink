import { useNavigate } from 'react-router-dom';
import { Box, Button, Stack, Typography } from '@mui/material';

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 3 }}>
      <Stack spacing={2} alignItems="center" textAlign="center">
        <Typography variant="h2" fontWeight={800} color="primary">
          404
        </Typography>
        <Typography variant="h6">Page not found</Typography>
        <Typography variant="body2" color="text.secondary" maxWidth={360}>
          The page you are looking for does not exist or may have been moved.
        </Typography>
        <Button variant="contained" onClick={() => navigate('/')}>
          Back to portals
        </Button>
      </Stack>
    </Box>
  );
}
