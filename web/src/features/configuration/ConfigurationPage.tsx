import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  Drawer,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import type { GridColDef } from '@mui/x-data-grid';
import { PageHeader } from '@/components/common/PageHeader';
import { DataTable } from '@/components/common/DataTable';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { usePortal } from '@/hooks/usePortal';
import { useConfigActions, useConfigHistory, useConfigSettings, useFeatureFlags } from '@/hooks/useAdminConfig';
import { configErrorMessage, formatConfigValue, MAX_CONFIG_REASON_LENGTH, parseConfigInput } from '@/services/adminConfig.service';
import { formatDateTime } from '@/utils/format';
import type { ConfigSetting, ConfigVersion, FeatureFlag } from '@/types';

const settingId = (s: Pick<ConfigSetting, 'namespace' | 'key'>) => `${s.namespace}/${s.key}`;
const preview = (s: ConfigSetting) => {
  const text = formatConfigValue(s.valueType, s.effectiveValue).replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || '—';
};

function ValueInput({ setting, value, onChange, error }: { setting: ConfigSetting; value: string; onChange: (v: string) => void; error?: string }) {
  // A JSON setting's `allowed` constrains the items of a list, not one choice: it is typed as JSON.
  const options = setting.valueType === 'BOOLEAN' ? ['true', 'false'] : setting.valueType === 'JSON' ? null : setting.allowed;
  if (options) {
    return (
      <TextField select size="small" label="New value" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <MenuItem key={o} value={o}>
            {o}
          </MenuItem>
        ))}
      </TextField>
    );
  }
  const range = [setting.min !== null ? `min ${setting.min}` : null, setting.max !== null ? `max ${setting.max}` : null].filter(Boolean).join(', ');
  return (
    <TextField
      size="small"
      label="New value"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      multiline={setting.valueType === 'JSON'}
      minRows={setting.valueType === 'JSON' ? 4 : undefined}
      error={!!error}
      helperText={
        error ??
        (setting.valueType === 'JSON' && setting.allowed
          ? `list of: ${setting.allowed.length ? setting.allowed.join(', ') : 'nothing yet ([])'}`
          : `${setting.valueType.toLowerCase()}${range ? ` (${range})` : ''}`)
      }
    />
  );
}

function SettingDrawer({ setting, onClose }: { setting: ConfigSetting | null; onClose: () => void }) {
  const actions = useConfigActions();
  const history = useConfigHistory(setting?.namespace ?? null, setting?.key ?? null);
  const [raw, setRaw] = useState(setting ? formatConfigValue(setting.valueType, setting.effectiveValue) : '');
  const [reason, setReason] = useState('');
  const [rollbackTo, setRollbackTo] = useState<ConfigVersion | null>(null);
  if (!setting) return null;

  const parsed = parseConfigInput(setting, raw);
  const unchanged = parsed.ok && JSON.stringify(parsed.value) === JSON.stringify(setting.effectiveValue);
  const busy = actions.update.isPending || actions.rollback.isPending;

  return (
    <Drawer anchor="right" open onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 520 } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ wordBreak: 'break-all' }}>
          {settingId(setting)}
        </Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseRoundedIcon />
        </IconButton>
      </Stack>
      <Divider />
      <Stack spacing={1.5} sx={{ p: 2 }}>
        <Typography variant="body2">{setting.description}</Typography>
        <Typography variant="body2" color="text.secondary">
          Effective: {preview(setting)} · source {setting.source.toLowerCase()}
          {setting.activeVersion !== null ? ` · version ${setting.activeVersion}` : ''}
        </Typography>

        <Divider />
        <Typography variant="subtitle2">Publish a new version</Typography>
        <ValueInput setting={setting} value={raw} onChange={setRaw} error={raw.trim() && !parsed.ok ? parsed.error : undefined} />
        <TextField
          size="small"
          label="Reason (recorded in the audit trail)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          inputProps={{ maxLength: MAX_CONFIG_REASON_LENGTH }}
        />
        <Button
          variant="contained"
          disabled={!parsed.ok || unchanged || busy}
          onClick={() =>
            parsed.ok &&
            actions.update.mutate({ namespace: setting.namespace, key: setting.key, valueType: setting.valueType, value: parsed.value, reason })
          }
        >
          Publish
        </Button>

        <Divider />
        <Typography variant="subtitle2">History</Typography>
        {history.error ? <Alert severity="error">{configErrorMessage(history.error, 'History could not be loaded.')}</Alert> : null}
        {history.isLoading ? <Skeleton variant="rounded" height={120} /> : null}
        {history.data && history.data.versions.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No published versions: the code default is in force.
          </Typography>
        ) : null}
        {history.data?.versions.map((v) => (
          <Stack key={v.version} spacing={0.5} sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="body2">
                Version {v.version}
                {v.isActive ? ' · active' : ''}
              </Typography>
              {!v.isActive ? (
                <Button size="small" disabled={busy} onClick={() => setRollbackTo(v)}>
                  Restore
                </Button>
              ) : null}
            </Stack>
            <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {formatConfigValue(v.valueType, v.value)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {formatDateTime(v.createdAt)}
              {v.reason ? ` · ${v.reason}` : ''}
            </Typography>
          </Stack>
        ))}
      </Stack>
      <ConfirmDialog
        open={rollbackTo !== null}
        title={`Restore version ${rollbackTo?.version ?? ''}?`}
        message="Its value is published again as a new version (re-validated by the server). The current version stays in the history."
        confirmLabel="Restore"
        onClose={() => setRollbackTo(null)}
        onConfirm={() => {
          if (rollbackTo) actions.rollback.mutate({ namespace: setting.namespace, key: setting.key, toVersion: rollbackTo.version, reason });
          setRollbackTo(null);
        }}
      />
    </Drawer>
  );
}

function SettingsTab() {
  const { data = [], isLoading, error } = useConfigSettings();
  const [selected, setSelected] = useState<ConfigSetting | null>(null);
  const columns: GridColDef<ConfigSetting>[] = [
    { field: 'namespace', headerName: 'Namespace', width: 140 },
    { field: 'key', headerName: 'Setting', flex: 1, minWidth: 220 },
    { field: 'effectiveValue', headerName: 'Effective value', flex: 1, minWidth: 180, sortable: false, valueGetter: (_v, row) => preview(row) },
    { field: 'source', headerName: 'Source', width: 120, valueFormatter: (v: string) => v.toLowerCase() },
    { field: 'activeVersion', headerName: 'Version', width: 90, valueFormatter: (v: number | null) => (v === null ? '—' : String(v)) },
    { field: 'updatedAt', headerName: 'Updated', width: 170, valueFormatter: (v: string | null) => (v ? formatDateTime(v) : '—') },
  ];
  return (
    <>
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {configErrorMessage(error, 'Settings could not be loaded.')}
        </Alert>
      ) : null}
      <DataTable
        rows={data}
        columns={columns as GridColDef[]}
        getRowId={(row) => settingId(row as ConfigSetting)}
        loading={isLoading}
        pageSize={25}
        onRowClick={(row) => setSelected(row as ConfigSetting)}
        emptyTitle="No governable settings"
      />
      {/* Re-mounted per setting so the form starts from that setting's value. */}
      <SettingDrawer key={selected ? settingId(selected) : 'none'} setting={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function FlagsTab() {
  const { data = [], isLoading, error } = useFeatureFlags();
  const actions = useConfigActions();
  const [pending, setPending] = useState<FeatureFlag | null>(null);
  const columns: GridColDef<FeatureFlag>[] = [
    { field: 'key', headerName: 'Flag', flex: 1, minWidth: 220 },
    { field: 'description', headerName: 'Description', flex: 1.5, minWidth: 240, valueFormatter: (v: string | null) => v ?? '—' },
    { field: 'updatedAt', headerName: 'Updated', width: 170, valueFormatter: (v: string) => formatDateTime(v) },
    {
      field: 'enabled',
      headerName: 'On',
      width: 90,
      sortable: false,
      renderCell: ({ row }) => (
        <Switch checked={row.enabled} disabled={actions.toggleFlag.isPending} onChange={() => setPending(row)} inputProps={{ 'aria-label': `Toggle ${row.key}` }} />
      ),
    },
  ];
  return (
    <>
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {configErrorMessage(error, 'Feature flags could not be loaded.')}
        </Alert>
      ) : null}
      <DataTable
        rows={data}
        columns={columns as GridColDef[]}
        getRowId={(row) => (row as FeatureFlag).key}
        loading={isLoading}
        pageSize={25}
        emptyTitle="No feature flags"
        emptyDescription="Flags appear here once they have been administered."
      />
      <ConfirmDialog
        open={pending !== null}
        title={`Turn ${pending?.key ?? ''} ${pending?.enabled ? 'off' : 'on'}?`}
        message="The change takes effect platform-wide and is audited."
        confirmLabel={pending?.enabled ? 'Turn off' : 'Turn on'}
        destructive={!!pending?.enabled}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) actions.toggleFlag.mutate({ key: pending.key, enabled: !pending.enabled });
          setPending(null);
        }}
      />
    </>
  );
}

/**
 * Platform configuration for the Super Admin (`config:manage:global`): versioned settings with
 * history and rollback (`/admin/config`) and feature flags (`/admin/feature-flags`). Every change
 * is a new, audited version; nothing is overwritten.
 */
export function ConfigurationPage() {
  const portal = usePortal();
  const [tab, setTab] = useState<'settings' | 'flags'>('settings');
  return (
    <>
      <PageHeader portalName={portal.title} title="Configuration" subtitle="Versioned platform settings and feature flags. Every change is audited." />
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tabs value={tab} onChange={(_e, v: 'settings' | 'flags') => setTab(v)}>
          <Tab value="settings" label="Settings" />
          <Tab value="flags" label="Feature flags" />
        </Tabs>
      </Box>
      {tab === 'settings' ? <SettingsTab /> : <FlagsTab />}
    </>
  );
}
