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
import AccountBalanceRoundedIcon from '@mui/icons-material/AccountBalanceRounded';
import { useAuth } from '@/context/AuthContext';
import { landingUrl, PORTALS } from '@/config/navigation';
import { getAuthErrorMessage, MfaRequiredError, type MfaChallenge } from '@/services/auth.service';
import type { PortalKey } from '@/types';
import { AdminMfaPanel } from './AdminMfaPanel';

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
  finance: {
    icon: AccountBalanceRoundedIcon,
    blurb: 'Payments, refunds, settlements and cash-on-delivery disputes.',
    tags: ['Payments', 'Refunds', 'Settlements', 'COD'],
  },
};

/** The administrator MFA step in progress (Work 66). Component memory only. */
interface PendingMfa {
  challenge: MfaChallenge;
  portal: PortalKey;
}

export function PortalSelectPage() {
  const { login, authError, clearAuthError } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [pendingMfa, setPendingMfa] = useState<PendingMfa | null>(null);
  const [busy, setBusy] = useState<PortalKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enter = async (portal: PortalKey) => {
    if (!identifier.trim() || !password) {
      setError('Enter your email or phone and password to continue.');
      return;
    }

    setBusy(portal);
    setPendingMfa(null);
    setError(null);
    clearAuthError();
    try {
      await login({ identifier, password, portal });
      navigate(landingUrl(portal));
    } catch (caught) {
      if (caught instanceof MfaRequiredError) {
        // The server decided this account needs administrator MFA; the password is no longer needed.
        setPassword('');
        setPendingMfa({ challenge: caught.challenge, portal });
      } else {
        setError(getAuthErrorMessage(caught));
      }
    } finally {
      setBusy(null);
    }
  };

  const restart = (message?: string) => {
    setPendingMfa(null);
    setError(message ?? null);
  };

  const visibleError = pendingMfa ? null : (error ?? authError);

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
          {visibleError && <Alert severity="error">{visibleError}</Alert>}
          {pendingMfa && (
            <AdminMfaPanel
              // A new challenge (e.g. after signing in again) starts the panel afresh.
              key={pendingMfa.challenge.token}
              challenge={pendingMfa.challenge}
              portal={pendingMfa.portal}
              onSignedIn={(user) => navigate(landingUrl(user.portal))}
              onRestart={restart}
            />
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
                    disabled={busy !== null || pendingMfa !== null}
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
                          disabled={busy !== null || pendingMfa !== null}
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
