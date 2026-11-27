import { useRef, useState } from 'react';
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
  adminDoctorsService,
  DOCTOR_DOCUMENT_KINDS,
  DOCTOR_FILE_TYPES,
  doctorActionMessage,
  doctorRegistrationProblem,
  type DoctorDocumentKind,
} from '@/services/adminDoctors.service';
import type { AdminAccount } from '@/types';

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}` : fallback;

/**
 * Work 169: the Super Admin registers a doctor (Work 166). The person signs up in the PharmaLink
 * app first (an ordinary customer account); here they are found by e-mail or phone, their medical
 * licence is recorded and approved, and they appear to patients at once. Facilities then name the
 * doctors who practise with them.
 */
export function RegisterDoctorDialog({ onClose, onRegistered }: { onClose: () => void; onRegistered: (doctorId: string) => void }) {
  const notify = useNotify();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);

  const [identifier, setIdentifier] = useState('');
  const [finding, setFinding] = useState(false);
  const [owner, setOwner] = useState<AdminAccount | null>(null);
  const [ownerProblem, setOwnerProblem] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [fullNameAm, setFullNameAm] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [licenseExpiresOn, setLicenseExpiresOn] = useState('');
  const [kind, setKind] = useState<DoctorDocumentKind>('MEDICAL_LICENSE');
  const [documents, setDocuments] = useState<Array<{ kind: DoctorDocumentKind; storageRef: string; name: string }>>([]);
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
      if (!found) setOwnerProblem('No account uses this e-mail or phone. Ask the doctor to sign up in the PharmaLink app first, then search again.');
      else if (found.status !== 'ACTIVE') setOwnerProblem(`This account is ${found.status.toLowerCase().replace(/_/g, ' ')}, so it cannot become a doctor.`);
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
      const storageRef = await adminDoctorsService.uploadDocument(owner.userId, file);
      setDocuments((d) => [...d, { kind, storageRef, name: file.name }]);
    } catch (error) {
      setProblem(message(error, 'The file could not be uploaded.'));
    } finally {
      setUploading(false);
    }
  }

  const form = { userId: owner?.userId ?? '', fullName, fullNameAm, specialty, licenseNumber, licenseExpiresOn, documents: documents.map(({ kind: k, storageRef }) => ({ kind: k, storageRef })) };
  const missing = doctorRegistrationProblem(form);

  async function submit() {
    setSaving(true);
    setProblem(null);
    try {
      const result = await adminDoctorsService.register(form);
      qc.invalidateQueries({ queryKey: ['doctors'] });
      notify(`${fullName.trim()} is registered. They can sign in and set their availability; facilities can now add them.`);
      onRegistered(result.doctorId);
    } catch (error) {
      setProblem(doctorActionMessage(error, 'The doctor could not be registered.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Register a doctor</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography variant="subtitle2">1. The doctor's account</Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              label="Doctor's e-mail or phone (+2519…)"
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
              Account: {owner.email ?? owner.phone}. It becomes a doctor's account.
            </Alert>
          ) : null}

          <Divider />
          <Typography variant="subtitle2">2. The doctor and their licence</Typography>
          <TextField size="small" label="Name patients see (e.g. Dr. Selamawit Bekele)" value={fullName} onChange={(e) => setFullName(e.target.value)} inputProps={{ maxLength: 160 }} disabled={!owner} />
          <TextField size="small" label="Name in Amharic (optional)" value={fullNameAm} onChange={(e) => setFullNameAm(e.target.value)} inputProps={{ maxLength: 160, lang: 'am' }} disabled={!owner} />
          <TextField size="small" label="Specialty (e.g. Cardiology)" value={specialty} onChange={(e) => setSpecialty(e.target.value)} inputProps={{ maxLength: 120 }} disabled={!owner} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField size="small" fullWidth label="Medical licence number" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} inputProps={{ maxLength: 64 }} disabled={!owner} />
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
            <TextField select size="small" label="Document" value={kind} onChange={(e) => setKind(e.target.value as DoctorDocumentKind)} sx={{ minWidth: 220 }} disabled={!owner}>
              {DOCTOR_DOCUMENT_KINDS.map((k) => (
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
              accept={DOCTOR_FILE_TYPES.join(',')}
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
              PDF, JPEG or PNG, up to 10 MB each. They stay in the doctor's record.
            </Typography>
          ) : null}
          <Box>
            {documents.map((d, i) => (
              <Stack key={d.storageRef} direction="row" alignItems="center" spacing={1} sx={{ py: 0.5 }}>
                <Chip size="small" label={DOCTOR_DOCUMENT_KINDS.find((k) => k.value === d.kind)?.label ?? d.kind} />
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
            Registering approves this medical licence in your name and lists the doctor for patients at once. It is recorded in the doctor's history.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!!missing || saving || uploading} onClick={submit} title={missing ?? undefined}>
          {saving ? 'Registering…' : 'Register doctor'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
