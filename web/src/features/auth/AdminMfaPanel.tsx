import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useAuth } from '@/context/AuthContext';
import { getAuthErrorMessage, PortalAccessError, type MfaChallenge, type MfaEnrollment } from '@/services/auth.service';
import { ApiError } from '@/services/apiClient';
import type { AuthUser, PortalKey } from '@/types';

interface AdminMfaPanelProps {
  challenge: MfaChallenge;
  portal: PortalKey;
  onSignedIn: (user: AuthUser) => void;
  /** Back to the password step (cancelled, or the challenge expired). */
  onRestart: (message?: string) => void;
}

type Step =
  | { kind: 'totp'; challenge: MfaChallenge }
  | { kind: 'recovery'; challenge: MfaChallenge }
  | { kind: 'enroll'; challenge: MfaChallenge; enrollment: MfaEnrollment | null }
  | { kind: 'codes'; user: AuthUser; recoveryCodes: string[] };

/**
 * Administrator MFA (Work 66): authenticator code, first-time enrolment, recovery code with a
 * mandatory replacement authenticator, and the one-time display of new recovery codes.
 *
 * Challenge tokens, the pending secret and recovery codes live only in this component's state:
 * never in storage, the URL or logs. No QR code is drawn: the portal has no local QR library and the
 * secret must never be sent to an external QR service, so the secret and `otpauth://` link are shown
 * for manual entry instead.
 */
export function AdminMfaPanel({ challenge, portal, onSignedIn, onRestart }: AdminMfaPanelProps) {
  const { startMfaEnrollment, confirmMfaEnrollment, verifyMfa, redeemRecoveryCode, acceptSession } = useAuth();
  const [step, setStep] = useState<Step>(() =>
    challenge.type === 'ENROLLMENT'
      ? { kind: 'enroll', challenge, enrollment: null }
      : { kind: 'totp', challenge },
  );
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (caught: unknown) => {
    if (caught instanceof PortalAccessError || (caught instanceof ApiError && caught.code === 'AUTH_MFA_CHALLENGE_INVALID')) {
      onRestart(getAuthErrorMessage(caught));
      return;
    }
    setError(getAuthErrorMessage(caught));
  };

  const enrollChallengeToken = step.kind === 'enroll' && !step.enrollment ? step.challenge.token : null;
  useEffect(() => {
    if (!enrollChallengeToken) return;
    let active = true;
    setBusy(true);
    startMfaEnrollment(enrollChallengeToken)
      .then((enrollment) => {
        if (active) setStep((current) => (current.kind === 'enroll' ? { ...current, enrollment } : current));
      })
      .catch((caught: unknown) => {
        if (active) fail(caught);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrollChallengeToken, startMfaEnrollment]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = () =>
    run(async () => {
      if (step.kind !== 'totp') return;
      const user = await verifyMfa(step.challenge.token, code, portal);
      setCode('');
      onSignedIn(user);
    });

  const submitEnrollment = () =>
    run(async () => {
      if (step.kind !== 'enroll') return;
      const result = await confirmMfaEnrollment(step.challenge.token, code);
      setCode('');
      setStep({ kind: 'codes', user: result.user, recoveryCodes: result.recoveryCodes });
    });

  const submitRecovery = () =>
    run(async () => {
      if (step.kind !== 'recovery') return;
      const replacement = await redeemRecoveryCode(step.challenge.token, recoveryCode);
      setRecoveryCode('');
      setStep({ kind: 'enroll', challenge: replacement, enrollment: null });
    });

  const finish = () =>
    run(async () => {
      if (step.kind !== 'codes') return;
      const user = await acceptSession(step.user, portal);
      setStep({ kind: 'codes', user, recoveryCodes: [] });
      onSignedIn(user);
    });

  const codeField = (onSubmit: () => void) => (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
      <TextField
        fullWidth
        label="Authenticator code"
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && code.length === 6) onSubmit();
        }}
        inputProps={{ inputMode: 'numeric', maxLength: 6, 'aria-label': 'Six-digit authenticator code' }}
        autoComplete="one-time-code"
        autoFocus
      />
      <Button variant="contained" onClick={onSubmit} disabled={busy || code.length !== 6}>
        {busy ? 'Checking…' : 'Verify'}
      </Button>
    </Stack>
  );

  return (
    <Paper variant="outlined" sx={{ p: 3, width: '100%', maxWidth: 640 }}>
      <Stack spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}

        {step.kind === 'totp' && (
          <>
            <Typography variant="h6" fontWeight={700}>
              Authenticator verification
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Administrator accounts need a second factor. Enter the six-digit code from your authenticator app.
            </Typography>
            {codeField(submitTotp)}
            <Link component="button" type="button" variant="body2" onClick={() => setStep({ kind: 'recovery', challenge: step.challenge })}>
              Lost your authenticator? Use a recovery code
            </Link>
          </>
        )}

        {step.kind === 'recovery' && (
          <>
            <Typography variant="h6" fontWeight={700}>
              Use a recovery code
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Each recovery code works once. After it is accepted you must set up a new authenticator before you can
              sign in, and your old authenticator stops working.
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                fullWidth
                label="Recovery code"
                placeholder="XXXX-XXXX-XXXX-XXXX"
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value.slice(0, 24))}
                autoComplete="off"
                autoFocus
              />
              <Button variant="contained" onClick={submitRecovery} disabled={busy || recoveryCode.trim().length < 16}>
                {busy ? 'Checking…' : 'Continue'}
              </Button>
            </Stack>
            <Link component="button" type="button" variant="body2" onClick={() => setStep({ kind: 'totp', challenge: step.challenge })}>
              Back to authenticator code
            </Link>
          </>
        )}

        {step.kind === 'enroll' && (
          <>
            <Typography variant="h6" fontWeight={700}>
              {step.challenge.reason === 'RECOVERY' ? 'Set up a replacement authenticator' : 'Set up your authenticator'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Administrator accounts must use an authenticator app (for example Google Authenticator, Microsoft
              Authenticator or 1Password). Add an account with the key below, then enter the code it shows.
            </Typography>
            {!step.enrollment && busy && <Typography variant="body2">Preparing your key…</Typography>}
            {step.enrollment && (
              <Stack spacing={1}>
                <Typography variant="body2" fontWeight={600}>
                  Setup key ({step.enrollment.issuer} · {step.enrollment.accountName})
                </Typography>
                <Box
                  component="code"
                  sx={{ p: 1.5, borderRadius: 1, bgcolor: 'action.hover', fontSize: 16, letterSpacing: 2, wordBreak: 'break-all' }}
                >
                  {step.enrollment.secret.match(/.{1,4}/g)?.join(' ')}
                </Box>
                <Typography variant="caption" color="text.secondary">
                  Time-based, {step.enrollment.digits} digits, every {step.enrollment.period} seconds. Apps that accept
                  a setup link can use this instead (copy it; don't share it):
                </Typography>
                <Box component="code" sx={{ fontSize: 12, wordBreak: 'break-all', userSelect: 'all' }}>
                  {step.enrollment.otpauthUri}
                </Box>
              </Stack>
            )}
            {step.enrollment && codeField(submitEnrollment)}
          </>
        )}

        {step.kind === 'codes' && (
          <>
            <Typography variant="h6" fontWeight={700}>
              Save your recovery codes
            </Typography>
            <Alert severity="warning">
              These codes are shown only once. Store them somewhere safe and offline. Each code can be used one time
              to sign in if you lose your authenticator.
            </Alert>
            <Box
              component="ul"
              sx={{ m: 0, p: 2, borderRadius: 1, bgcolor: 'action.hover', columns: 2, listStyle: 'none', fontFamily: 'monospace' }}
            >
              {step.recoveryCodes.map((recovery) => (
                <li key={recovery}>{recovery}</li>
              ))}
            </Box>
            <FormControlLabel
              control={<Checkbox checked={saved} onChange={(event) => setSaved(event.target.checked)} />}
              label="I have saved my recovery codes"
            />
            <Button variant="contained" onClick={finish} disabled={!saved}>
              Continue to the portal
            </Button>
          </>
        )}

        {step.kind !== 'codes' && (
          <Button variant="text" onClick={() => onRestart()} disabled={busy}>
            Cancel and start again
          </Button>
        )}
      </Stack>
    </Paper>
  );
}
