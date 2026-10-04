import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Container,
  Grid,
  Stack,
  TextField,
  Typography,
  alpha,
} from '@mui/material';
import LocalPharmacyRoundedIcon from '@mui/icons-material/LocalPharmacyRounded';
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded';
import AdminPanelSettingsRoundedIcon from '@mui/icons-material/AdminPanelSettingsRounded';
import ShieldRoundedIcon from '@mui/icons-material/ShieldRounded';
import { useAuth } from '@/context/AuthContext';
import { PORTALS } from '@/config/navigation';
import { getAuthErrorMessage, OtpRequiredError } from '@/services/auth.service';
import type { PortalKey } from '@/types';

const PORTAL_META: Record<PortalKey, { icon: typeof StorefrontRoundedIcon; blurb: string; tags: string[] }> = {
  pharmacy: {
    icon: StorefrontRoundedIcon,
    blurb: 'Manage your inventory, fulfil orders, track performance and coordinate your team.',
    tags: ['Inventory', 'Orders', 'Analytics', 'Staff'],
  },
  admin: {
    icon: AdminPanelSettingsRoundedIcon,
    blurb: 'Oversee pharmacies, orders and compliance across the marketplace.',
    tags: ['Pharmacies', 'Orders', 'Reports', 'Audit'],
  },
  superadmin: {
    icon: ShieldRoundedIcon,
    blurb: 'Full platform control including roles, permissions and configuration.',
    tags: ['Roles', 'All Portals', 'Audit', 'Settings'],
  },
};

interface PendingOtp {
  identifier: string;
  portal: PortalKey;
}

export function PortalSelectPage() {
  const { login, verifyOtp, resendOtp, authError, clearAuthError } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [pendingOtp, setPendingOtp] = useState<PendingOtp | null>(null);
  const [busy, setBusy] = useState<PortalKey | null>(null);
  const [otpBusy, setOtpBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enter = async (portal: PortalKey) => {
    if (!identifier.trim() || !password) {
      setError('Enter your email or phone and password to continue.');
      return;
    }

    setBusy(portal);
    setPendingOtp(null);
    setError(null);
    clearAuthError();
    try {
      await login({ identifier, password, portal });
      navigate(`${PORTALS[portal].basePath}/dashboard`);
    } catch (caught) {
      if (caught instanceof OtpRequiredError) {
        setPendingOtp({ identifier: caught.identifier, portal });
        setOtp('');
      } else {
        setError(getAuthErrorMessage(caught));
      }
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    if (!pendingOtp || otp.trim().length !== 6) {
      setError('Enter the six-digit verification code.');
      return;
    }

    setOtpBusy(true);
    setError(null);
    clearAuthError();
    try {
      await verifyOtp({ identifier: pendingOtp.identifier, code: otp.trim(), portal: pendingOtp.portal });
      navigate(`${PORTALS[pendingOtp.portal].basePath}/dashboard`);
    } catch (caught) {
      setError(getAuthErrorMessage(caught));
    } finally {
      setOtpBusy(false);
    }
  };

  const resend = async () => {
    if (!pendingOtp) return;
    setOtpBusy(true);
    setError(null);
    try {
      await resendOtp(pendingOtp.identifier);
      setError('A new verification code has been requested.');
    } catch (caught) {
      setError(getAuthErrorMessage(caught));
    } finally {
      setOtpBusy(false);
    }
  };

  const visibleError = error ?? authError;

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        background: (t) =>
          `radial-gradient(1200px 600px at 10% -10%, ${alpha(t.palette.primary.main, 0.18)}, transparent),` +
          `radial-gradient(1000px 500px at 110% 10%, ${alpha(t.palette.secondary.main, 0.14)}, transparent)`,
      }}
    >
      <Container maxWidth="lg" sx={{ py: 6 }}>
        <Stack spacing={1} alignItems="center" sx={{ mb: 5, textAlign: 'center' }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box
              sx={{
                width: 48,
                height: 48,
                borderRadius: 2.5,
                display: 'grid',
                placeItems: 'center',
                bgcolor: 'primary.main',
                color: '#fff',
              }}
            >
              <LocalPharmacyRoundedIcon />
            </Box>
            <Typography variant="h4" fontWeight={800}>
              PharmaLink Ethiopia
            </Typography>
          </Stack>
          <Typography variant="h6" color="text.secondary" fontWeight={500}>
            Operations Console
          </Typography>
          <Typography variant="body2" color="text.secondary" maxWidth={520}>
            Select a workspace to continue. Each portal is scoped to the right data and
            permissions for its users.
          </Typography>
        </Stack>

        <Stack spacing={2} alignItems="center" sx={{ mb: 4 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ width: '100%', maxWidth: 640 }}>
            <TextField
              fullWidth
              label="Email or phone"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              autoComplete="username"
            />
            <TextField
              fullWidth
              label="Password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Stack>
          {visibleError && <Alert severity={error === 'A new verification code has been requested.' ? 'info' : 'error'}>{visibleError}</Alert>}
          {pendingOtp && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ width: '100%', maxWidth: 640 }}>
              <TextField
                fullWidth
                label="Verification code"
                value={otp}
                onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputProps={{ inputMode: 'numeric', maxLength: 6 }}
                autoComplete="one-time-code"
              />
              <Button variant="contained" onClick={verify} disabled={otpBusy}>
                {otpBusy ? 'Verifying…' : 'Verify code'}
              </Button>
              <Button variant="text" onClick={resend} disabled={otpBusy}>
                Resend
              </Button>
            </Stack>
          )}
        </Stack>

        <Grid container spacing={3}>
          {(Object.keys(PORTALS) as PortalKey[]).map((key) => {
            const portal = PORTALS[key];
            const meta = PORTAL_META[key];
            const Icon = meta.icon;
            return (
              <Grid item xs={12} md={4} key={key}>
                <Card sx={{ height: '100%', borderTop: `4px solid ${portal.accent}` }}>
                  <CardActionArea
                    sx={{ height: '100%', alignItems: 'stretch' }}
                    onClick={() => void enter(key)}
                    disabled={busy !== null || otpBusy}
                  >
                    <CardContent sx={{ p: 3 }}>
                      <Stack spacing={2}>
                        <Box
                          sx={{
                            width: 52,
                            height: 52,
                            borderRadius: 2,
                            display: 'grid',
                            placeItems: 'center',
                            bgcolor: alpha(portal.accent, 0.12),
                            color: portal.accent,
                          }}
                        >
                          <Icon fontSize="large" />
                        </Box>
                        <Box>
                          <Typography variant="h6" fontWeight={800}>
                            {portal.title}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {meta.blurb}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                          {meta.tags.map((tag) => (
                            <Chip key={tag} label={tag} size="small" variant="outlined" />
                          ))}
                        </Stack>
                        <Button
                          variant="contained"
                          sx={{ bgcolor: portal.accent, '&:hover': { bgcolor: portal.accent } }}
                          disabled={busy !== null || otpBusy}
                        >
                          {busy === key ? 'Signing in…' : `Enter ${portal.shortTitle}`}
                        </Button>
                      </Stack>
                    </CardContent>
                  </CardActionArea>
                </Card>
              </Grid>
            );
          })}
        </Grid>
      </Container>
    </Box>
  );
}
