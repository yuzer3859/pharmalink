import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded';
import { useQueryClient } from '@tanstack/react-query';
import { useNotify } from '@/context/NotificationContext';
import { adminAccountsService } from '@/services/adminAccounts.service';
import { ApiError } from '@/services/apiClient';
import {
  adminProvidersService,
  FACILITY_DOCUMENT_KINDS,
  FACILITY_FILE_TYPES,
  PROVIDER_TYPES,
  providerRegistrationProblem,
  type FacilityDocumentKind,
  type ProviderType,
} from '@/services/adminProviders.service';
import type { AdminAccount } from '@/types';

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}` : fallback;

/**
 * Work 163: the Super Admin registers a hospital, clinic, diagnostic centre or lab for its
 * administrator (Work 160). The administrator is an existing account, found by e-mail or phone (a
 * new one signs up in the PharmaLink app first). One administrator may run several facilities:
 * each registration is a new organisation with its own facility licence.
 */
export function RegisterProviderDialog({ onClose, onRegistered }: { onClose: () => void; onRegistered: (providerId: string) => void }) {
  const notify = useNotify();
  const qc = useQueryClient();
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const input = useRef<HTMLInputElement>(null);

  const [identifier, setIdentifier] = useState('');
  const [finding, setFinding] = useState(false);
  const [owner, setOwner] = useState<AdminAccount | null>(null);
  const [ownerProblem, setOwnerProblem] = useState<string | null>(null);

  const [type, setType] = useState<ProviderType>('HOSPITAL');
  const [legalName, setLegalName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [licenseExpiresOn, setLicenseExpiresOn] = useState('');
  const [kind, setKind] = useState<FacilityDocumentKind>('FACILITY_LICENSE');
  const [documents, setDocuments] = useState<Array<{ kind: FacilityDocumentKind; storageRef: string; name: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function findOwner() {
    setFinding(true);
    setOwner(null);
    setOwnerProblem(null);
    setDocuments([]);
    try {
      const page = await adminAccountsService.list({ identifier: identifier.trim(), size: 1 });
      const found = page.items[0];
      if (!found) setOwnerProblem('No account uses this e-mail or phone. Ask the administrator to sign up in the PharmaLink app first, then search again.');
      else if (found.status !== 'ACTIVE') setOwnerProblem(`This account is ${found.status.toLowerCase().replace(/_/g, ' ')}, so it cannot run a facility.`);
      else setOwner(found);
    } catch (error) {
      setOwnerProblem(message(error, 'The account could not be looked up.'));
    } finally {
      setFinding(false);
    }
  }

  async function addFile(file: File | undefined) {
    if (!file || !owner) return;
    setProblem(null);
    setUploading(true);
    try {
      const storageRef = await adminProvidersService.uploadLicenceFile(owner.userId, file);
      setDocuments((d) => [...d, { kind, storageRef, name: file.name }]);
    } catch (error) {
      setProblem(message(error, 'The file could not be uploaded.'));
    } finally {
      setUploading(false);
    }
  }

  const form = { adminUserId: owner?.userId ?? '', type, legalName, displayName, licenseNumber, licenseExpiresOn, documents: documents.map(({ kind: k, storageRef }) => ({ kind: k, storageRef })) };
  const missing = providerRegistrationProblem(form);

  async function submit() {
    setSaving(true);
    setProblem(null);
    try {
      const result = await adminProvidersService.register({ ...form, idempotencyKey });
      qc.invalidateQueries({ queryKey: ['providers'] });
      notify(`${displayName.trim()} is registered and active. Its administrator can now set up its locations and services.`);
      onRegistered(result.providerId);
    } catch (error) {
      setProblem(message(error, 'The provider could not be registered.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Register a healthcare provider</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography variant="subtitle2">1. The administrator</Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              label="Administrator's e-mail or phone (+2519…)"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && identifier.trim().length >= 3) findOwner();
              }}
            />
            <Button variant="outlined" startIcon={finding ? <CircularProgress size={14} /> : <SearchRoundedIcon />} disabled={finding || identifier.trim().length < 3} onClick={findOwner}>
              Find
            </Button>
          </Stack>
          {ownerProblem ? <Alert severity="warning">{ownerProblem}</Alert> : null}
          {owner ? (
            <Alert severity="success">
              Administrator: {owner.email ?? owner.phone}. They can run several facilities; this one is added to theirs.
            </Alert>
          ) : null}

          <Divider />
          <Typography variant="subtitle2">2. The provider and its licence</Typography>
          <TextField select size="small" label="Type" value={type} onChange={(e) => setType(e.target.value as ProviderType)} disabled={!owner}>
            {PROVIDER_TYPES.map((t) => (
              <MenuItem key={t.value} value={t.value}>
                {t.label}
              </MenuItem>
            ))}
          </TextField>
          <TextField size="small" label="Legal name (as on the licence)" value={legalName} onChange={(e) => setLegalName(e.target.value)} inputProps={{ maxLength: 200 }} disabled={!owner} />
          <TextField size="small" label="Name customers see" value={displayName} onChange={(e) => setDisplayName(e.target.value)} inputProps={{ maxLength: 200 }} disabled={!owner} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField size="small" fullWidth label="Licence number" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} inputProps={{ maxLength: 64 }} disabled={!owner} />
            <TextField
              size="small"
              fullWidth
              type="date"
              label="Licence valid until"
              value={licenseExpiresOn}
              onChange={(e) => setLicenseExpiresOn(e.target.value)}
              InputLabelProps={{ shrink: true }}
              disabled={!owner}
            />
          </Stack>

          <Divider />
          <Typography variant="subtitle2">3. Licence files</Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField select size="small" label="Document" value={kind} onChange={(e) => setKind(e.target.value as FacilityDocumentKind)} sx={{ minWidth: 220 }} disabled={!owner}>
              {FACILITY_DOCUMENT_KINDS.map((k) => (
                <MenuItem key={k.value} value={k.value}>
                  {k.label}
                </MenuItem>
              ))}
            </TextField>
            <Button
              variant="outlined"
              startIcon={uploading ? <CircularProgress size={14} /> : <UploadFileRoundedIcon />}
              disabled={!owner || uploading || documents.length >= 10}
              onClick={() => input.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Upload file'}
            </Button>
            <input
              ref={input}
              hidden
              type="file"
              accept={FACILITY_FILE_TYPES.join(',')}
              aria-label="Licence file"
              data-testid="licence-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                addFile(file);
              }}
            />
          </Stack>
          {documents.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              PDF, JPEG or PNG, up to 10 MB each. They stay in the provider's record.
            </Typography>
          ) : null}
          <Box>
            {documents.map((d, i) => (
              <Stack key={d.storageRef} direction="row" alignItems="center" spacing={1} sx={{ py: 0.5 }}>
                <Chip size="small" label={FACILITY_DOCUMENT_KINDS.find((k) => k.value === d.kind)?.label ?? d.kind} />
                <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                  {d.name}
                </Typography>
                <IconButton size="small" aria-label={`Remove ${d.name}`} onClick={() => setDocuments((list) => list.filter((_, j) => j !== i))}>
                  <DeleteOutlineRoundedIcon fontSize="small" />
                </IconButton>
              </Stack>
            ))}
          </Box>

          {problem ? <Alert severity="error">{problem}</Alert> : null}
          <Typography variant="caption" color="text.secondary">
            Registering approves this facility licence in your name and makes the provider active at once. It is recorded in the provider's history.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!!missing || saving || uploading} onClick={submit} title={missing ?? undefined}>
          {saving ? 'Registering…' : 'Register provider'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
