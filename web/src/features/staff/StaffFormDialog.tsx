import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from '@mui/material';
import { useStaffMutations } from '@/hooks/useStaff';
import { useRoles } from '@/hooks/useRoles';
import { useAuth } from '@/context/AuthContext';
import type { StaffMember } from '@/types';

interface Props {
  open: boolean;
  member: StaffMember | null;
  onClose: () => void;
}

interface FormState {
  name: string;
  email: string;
  phone: string;
  roleId: string;
  status: StaffMember['status'];
}

const empty: FormState = { name: '', email: '', phone: '', roleId: '', status: 'invited' };

export function StaffFormDialog({ open, member, onClose }: Props) {
  const { user } = useAuth();
  const { data: roles = [] } = useRoles();
  const { create, update } = useStaffMutations();
  const [form, setForm] = useState<FormState>(empty);

  useEffect(() => {
    if (member) {
      setForm({
        name: member.name,
        email: member.email,
        phone: member.phone,
        roleId: member.roleId,
        status: member.status,
      });
    } else {
      setForm({ ...empty, roleId: roles[0]?.id ?? '' });
    }
  }, [member, open, roles]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = () => {
    const role = roles.find((r) => r.id === form.roleId);
    const payload = {
      name: form.name,
      email: form.email,
      phone: form.phone,
      roleId: form.roleId,
      roleName: role?.name ?? 'Staff',
      status: form.status,
      pharmacyId: user?.pharmacyId,
      pharmacyName: user?.pharmacyName,
    };
    if (member) {
      update.mutate({ id: member.id, patch: payload }, { onSuccess: onClose });
    } else {
      create.mutate(payload, { onSuccess: onClose });
    }
  };

  const submitting = create.isPending || update.isPending;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{member ? 'Edit Staff Member' : 'Invite Staff Member'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <TextField
            label="Full name"
            size="small"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
          />
          <TextField
            label="Email"
            size="small"
            type="email"
            value={form.email}
            onChange={(e) => setField('email', e.target.value)}
          />
          <TextField
            label="Phone"
            size="small"
            value={form.phone}
            onChange={(e) => setField('phone', e.target.value)}
          />
          <TextField
            select
            label="Role"
            size="small"
            value={form.roleId}
            onChange={(e) => setField('roleId', e.target.value)}
          >
            {roles.map((r) => (
              <MenuItem key={r.id} value={r.id}>
                {r.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Status"
            size="small"
            value={form.status}
            onChange={(e) => setField('status', e.target.value as StaffMember['status'])}
          >
            <MenuItem value="active">Active</MenuItem>
            <MenuItem value="invited">Invited</MenuItem>
            <MenuItem value="suspended">Suspended</MenuItem>
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={submit}
          disabled={submitting || !form.name || !form.email || !form.roleId}
        >
          {member ? 'Save changes' : 'Send invite'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
