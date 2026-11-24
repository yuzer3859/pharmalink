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
  LICENCE_FILE_TYPES,
  LICENCE_KINDS,
  pharmacyRegistrationService,
  registrationProblem,
  type LicenceKind,
} from '@/services/pharmacies.service';
import type { AdminAccount } from '@/types';

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}` : fallback;

/**
 * Work 154: the Super Admin registers a pharmacy for an owner. The owner is an existing account,
 * found by e-mail or phone (a new owner signs up in the PharmaLink app first). One owner may hold
 * several pharmacies: each registration is a new organisation with its own licence.
 */
export function RegisterPharmacyDialog({ onClose, onRegistered }: { onClose: () => void; onRegistered: (opened: { pharmacyId: string; organizationId: string }) => void }) {
  const notify = useNotify();
  const qc = useQueryClient();
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const input = useRef<HTMLInputElement>(null);

  const [identifier, setIdentifier] = useState('');
  const [finding, setFinding] = useState(false);
  const [owner, setOwner] = useState<AdminAccount | null>(null);
  const [ownerProblem, setOwnerProblem] = useState<string | null>(null);

  const [legalName, setLegalName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [licenseExpiresOn, setLicenseExpiresOn] = useState('');
  const [kind, setKind] = useState<LicenceKind>('PHARMACY_LICENSE');
  const [documents, setDocuments] = useState<Array<{ kind: LicenceKind; storageRef: string; name: string }>>([]);
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
      if (!found) setOwnerProblem('No account uses this e-mail or phone. Ask the owner to sign up in the PharmaLink app first, then search again.');
      else if (found.status !== 'ACTIVE') setOwnerProblem(`This account is ${found.status.toLowerCase().replace(/_/g, ' ')}, so it cannot own a pharmacy.`);
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
      const storageRef = await pharmacyRegistrationService.uploadLicenceFile(owner.userId, file);
      setDocuments((d) => [...d, { kind, storageRef, name: file.name }]);
    } catch (error) {
      setProblem(message(error, 'The file could not be uploaded.'));
    } finally {
      setUploading(false);
    }
  }

  const form = { ownerUserId: owner?.userId ?? '', legalName, displayName, licenseNumber, licenseExpiresOn, documents: documents.map(({ kind: k, storageRef }) => ({ kind: k, storageRef })) };
  const missing = registrationProblem(form);

  async function submit() {
    setSaving(true);
    setProblem(null);
    try {
      const result = await pharmacyRegistrationService.register({ ...form, idempotencyKey });
      qc.invalidateQueries({ queryKey: ['pharmacies'] });
      notify(`${displayName.trim()} is registered and active. Its owner can sign in to the pharmacy portal now.`);
      onRegistered({ pharmacyId: result.pharmacyId, organizationId: result.organizationId });
    } catch (error) {
      setProblem(message(error, 'The pharmacy could not be registered.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Register a pharmacy</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography variant="subtitle2">1. The owner</Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              label="Owner's e-mail or phone (+2519…)"
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
              Owner: {owner.email ?? owner.phone}. They can own several pharmacies; this one is added to theirs.
            </Alert>
          ) : null}

          <Divider />
          <Typography variant="subtitle2">2. The pharmacy and its licence</Typography>
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
            <TextField select size="small" label="Document" value={kind} onChange={(e) => setKind(e.target.value as LicenceKind)} sx={{ minWidth: 220 }} disabled={!owner}>
              {LICENCE_KINDS.map((k) => (
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
              accept={LICENCE_FILE_TYPES.join(',')}
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
              PDF, JPEG or PNG, up to 10 MB each. They stay in the pharmacy's record.
            </Typography>
          ) : null}
          <Box>
            {documents.map((d, i) => (
              <Stack key={d.storageRef} direction="row" alignItems="center" spacing={1} sx={{ py: 0.5 }}>
                <Chip size="small" label={LICENCE_KINDS.find((k) => k.value === d.kind)?.label ?? d.kind} />
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
            Registering approves this licence in your name and opens the pharmacy for business at once. It is recorded in the pharmacy's history.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!!missing || saving || uploading} onClick={submit} title={missing ?? undefined}>
          {saving ? 'Registering…' : 'Register pharmacy'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
