import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useRoleMutations } from '@/hooks/useRoles';
import { PERMISSION_CATALOG } from '@/services/roles.service';
import type { PermissionKey, PortalKey, Role } from '@/types';

interface Props {
  open: boolean;
  role: Role | null;
  portalKey: PortalKey;
  onClose: () => void;
}

export function RoleFormDialog({ open, role, portalKey, onClose }: Props) {
  const { create, update } = useRoleMutations();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<PermissionKey[]>([]);

  useEffect(() => {
    if (role) {
      setName(role.name);
      setDescription(role.description);
      setPermissions(role.permissions);
    } else {
      setName('');
      setDescription('');
      setPermissions(['dashboard:view']);
    }
  }, [role, open]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof PERMISSION_CATALOG>();
    PERMISSION_CATALOG.forEach((p) => {
      const list = map.get(p.group) ?? [];
      list.push(p);
      map.set(p.group, list);
    });
    return Array.from(map.entries());
  }, []);

  const toggle = (key: PermissionKey) =>
    setPermissions((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
    );

  const submit = () => {
    const payload = { name, description, portal: role?.portal ?? portalKey, permissions };
    if (role) {
      update.mutate({ id: role.id, patch: payload }, { onSuccess: onClose });
    } else {
      create.mutate(payload, { onSuccess: onClose });
    }
  };

  const submitting = create.isPending || update.isPending;
  const readOnly = role?.isSystem ?? false;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{role ? (readOnly ? 'View Role' : 'Edit Role') : 'Create Role'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <TextField
            label="Role name"
            size="small"
            value={name}
            disabled={readOnly}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label="Description"
            size="small"
            multiline
            minRows={2}
            value={description}
            disabled={readOnly}
            onChange={(e) => setDescription(e.target.value)}
          />

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Permissions
            </Typography>
            <Stack spacing={1.5}>
              {grouped.map(([group, perms]) => (
                <Box key={group}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>
                    {group}
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap' }}>
                    {perms.map((perm) => (
                      <FormControlLabel
                        key={perm.key}
                        sx={{ width: '50%', m: 0 }}
                        control={
                          <Checkbox
                            size="small"
                            checked={permissions.includes(perm.key)}
                            disabled={readOnly}
                            onChange={() => toggle(perm.key)}
                          />
                        }
                        label={<Typography variant="body2">{perm.label}</Typography>}
                      />
                    ))}
                  </Box>
                </Box>
              ))}
            </Stack>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose}>
          {readOnly ? 'Close' : 'Cancel'}
        </Button>
        {!readOnly && (
          <Button variant="contained" onClick={submit} disabled={submitting || !name}>
            {role ? 'Save changes' : 'Create role'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
