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
import {
  adminDriversService,
  DRIVER_DOCUMENT_KINDS,
  DRIVER_FILE_TYPES,
  driverRegistrationProblem,
  VEHICLE_TYPES,
  type DriverDocumentKind,
  type VehicleType,
} from '@/services/adminDrivers.service';
import { ApiError } from '@/services/apiClient';
import type { AdminAccount } from '@/types';

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}` : fallback;

/**
 * Work 156: the Super Admin registers a driver. The person signs up in the PharmaLink app first
 * (an ordinary account); here they are found by e-mail or phone, their vehicle and documents are
 * recorded and approved, and they become a driver who can sign in to the driver app.
 */
export function RegisterDriverDialog({ onClose, onRegistered }: { onClose: () => void; onRegistered: (userId: string) => void }) {
  const notify = useNotify();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);

  const [identifier, setIdentifier] = useState('');
  const [finding, setFinding] = useState(false);
  const [person, setPerson] = useState<AdminAccount | null>(null);
  const [personProblem, setPersonProblem] = useState<string | null>(null);
  const [vehicleType, setVehicleType] = useState<VehicleType>('MOTORCYCLE');
  const [plateNumber, setPlateNumber] = useState('');
  const [documentsExpireOn, setDocumentsExpireOn] = useState('');
  const [radiusKm, setRadiusKm] = useState('15');
  const [kind, setKind] = useState<DriverDocumentKind>('DRIVING_LICENSE');
  const [documents, setDocuments] = useState<Array<{ kind: DriverDocumentKind; storageRef: string; name: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function findPerson() {
    setFinding(true);
    setPerson(null);
    setPersonProblem(null);
    setDocuments([]);
    try {
      const found = (await adminAccountsService.list({ identifier: identifier.trim(), size: 1 })).items[0];
      if (!found) setPersonProblem('No account uses this e-mail or phone. Ask them to sign up in the PharmaLink app first, then search again.');
      else if (found.primaryRole === 'DRIVER') setPersonProblem('This account is already a driver.');
      else if (found.primaryRole !== 'CUSTOMER') setPersonProblem('Only an ordinary customer account can become a driver (not staff or a pharmacy).');
      else if (found.status !== 'ACTIVE') setPersonProblem(`This account is ${found.status.toLowerCase().replace(/_/g, ' ')}.`);
      else setPerson(found);
    } catch (error) {
      setPersonProblem(message(error, 'The account could not be looked up.'));
    } finally {
      setFinding(false);
    }
  }

  async function addFile(file: File | undefined) {
    if (!file || !person) return;
    setProblem(null);
    setUploading(true);
    try {
      const storageRef = await adminDriversService.uploadDocument(person.userId, file);
      setDocuments((d) => [...d, { kind, storageRef, name: file.name }]);
    } catch (error) {
      setProblem(message(error, 'The file could not be uploaded.'));
    } finally {
      setUploading(false);
    }
  }

  const form = {
    userId: person?.userId ?? '',
    vehicleType,
    plateNumber,
    documentsExpireOn,
    documents: documents.map(({ kind: k, storageRef }) => ({ kind: k, storageRef })),
    radiusKm: Number(radiusKm),
  };
  const missing = driverRegistrationProblem(form);

  async function submit() {
    setSaving(true);
    setProblem(null);
    try {
      const result = await adminDriversService.register(form);
      qc.invalidateQueries({ queryKey: ['drivers'] });
      notify('Driver registered. They can sign in to the driver app and go online.');
      onRegistered(result.userId);
    } catch (error) {
      setProblem(message(error, 'The driver could not be registered.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Register a driver</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography variant="subtitle2">1. The person</Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              label="Their e-mail or phone (+2519…)"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && identifier.trim().length >= 3) findPerson();
              }}
            />
            <Button variant="outlined" startIcon={finding ? <CircularProgress size={14} /> : <SearchRoundedIcon />} disabled={finding || identifier.trim().length < 3} onClick={findPerson}>
              Find
            </Button>
          </Stack>
          {personProblem ? <Alert severity="warning">{personProblem}</Alert> : null}
          {person ? <Alert severity="success">Found: {person.email ?? person.phone}.</Alert> : null}

          <Divider />
          <Typography variant="subtitle2">2. Vehicle and working area</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField select size="small" fullWidth label="Vehicle" value={vehicleType} onChange={(e) => setVehicleType(e.target.value as VehicleType)} disabled={!person}>
              {VEHICLE_TYPES.map((v) => (
                <MenuItem key={v.value} value={v.value}>
                  {v.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField size="small" fullWidth label="Plate number" value={plateNumber} onChange={(e) => setPlateNumber(e.target.value)} inputProps={{ maxLength: 20 }} disabled={!person} />
          </Stack>
          <TextField
            size="small"
            type="number"
            label="Works within (km of central Addis Ababa)"
            value={radiusKm}
            onChange={(e) => setRadiusKm(e.target.value)}
            inputProps={{ min: 0.5, max: 50, step: 0.5 }}
            disabled={!person}
          />

          <Divider />
          <Typography variant="subtitle2">3. Documents</Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField select size="small" label="Document" value={kind} onChange={(e) => setKind(e.target.value as DriverDocumentKind)} sx={{ minWidth: 230 }} disabled={!person}>
              {DRIVER_DOCUMENT_KINDS.map((k) => (
                <MenuItem key={k.value} value={k.value}>
                  {k.label}
                </MenuItem>
              ))}
            </TextField>
            <Button
              variant="outlined"
              startIcon={uploading ? <CircularProgress size={14} /> : <UploadFileRoundedIcon />}
              disabled={!person || uploading || documents.length >= 10}
              onClick={() => input.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Upload file'}
            </Button>
            <input
              ref={input}
              hidden
              type="file"
              accept={DRIVER_FILE_TYPES.join(',')}
              aria-label="Driver document"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                addFile(file);
              }}
            />
          </Stack>
          <Box>
            {documents.map((d, i) => (
              <Stack key={d.storageRef} direction="row" alignItems="center" spacing={1} sx={{ py: 0.5 }}>
                <Chip size="small" label={DRIVER_DOCUMENT_KINDS.find((k) => k.value === d.kind)?.label ?? d.kind} />
                <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                  {d.name}
                </Typography>
                <IconButton size="small" aria-label={`Remove ${d.name}`} onClick={() => setDocuments((list) => list.filter((_, j) => j !== i))}>
                  <DeleteOutlineRoundedIcon fontSize="small" />
                </IconButton>
              </Stack>
            ))}
          </Box>
          <TextField
            size="small"
            type="date"
            label="Documents valid until (the earliest expiry)"
            value={documentsExpireOn}
            onChange={(e) => setDocumentsExpireOn(e.target.value)}
            InputLabelProps={{ shrink: true }}
            disabled={!person}
          />

          {problem ? <Alert severity="error">{problem}</Alert> : null}
          <Typography variant="caption" color="text.secondary">
            Registering approves these documents in your name. When they expire, the driver cannot go online until new ones are approved.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!!missing || saving || uploading} onClick={submit} title={missing ?? undefined}>
          {saving ? 'Registering…' : 'Register driver'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
