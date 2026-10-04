import { NavLink, useLocation } from 'react-router-dom';
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Stack,
  Toolbar,
  Typography,
  alpha,
} from '@mui/material';
import LocalPharmacyRoundedIcon from '@mui/icons-material/LocalPharmacyRounded';
import { useAuth } from '@/context/AuthContext';
import { NAV_SECTIONS, PORTALS } from '@/config/navigation';

export const DRAWER_WIDTH = 264;

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user, can } = useAuth();
  const location = useLocation();
  if (!user) return null;

  const portal = PORTALS[user.portal];
  const items = portal.nav.filter((item) => can(item.permission));

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Toolbar sx={{ px: 2.5 }}>
        <Stack direction="row" spacing={1.25} alignItems="center">
          <Box
            sx={{
              width: 38,
              height: 38,
              borderRadius: 2,
              display: 'grid',
              placeItems: 'center',
              bgcolor: portal.accent,
              color: '#fff',
            }}
          >
            <LocalPharmacyRoundedIcon fontSize="small" />
          </Box>
          <Box>
            <Typography variant="subtitle1" fontWeight={800} lineHeight={1.1}>
              PharmaLink
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {portal.title}
            </Typography>
          </Box>
        </Stack>
      </Toolbar>

      <Box sx={{ flex: 1, overflowY: 'auto', px: 1.5, pb: 2 }}>
        {NAV_SECTIONS.map((section) => {
          const sectionItems = items.filter((i) => i.section === section);
          if (!sectionItems.length) return null;
          return (
            <List
              key={section}
              subheader={
                <ListSubheader
                  disableSticky
                  sx={{ bgcolor: 'transparent', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' }}
                >
                  {section}
                </ListSubheader>
              }
            >
              {sectionItems.map((item) => {
                const to = `${portal.basePath}/${item.path}`;
                const active = location.pathname.startsWith(to);
                const Icon = item.icon;
                return (
                  <ListItemButton
                    key={item.path}
                    component={NavLink}
                    to={to}
                    onClick={onNavigate}
                    selected={active}
                    sx={{
                      borderRadius: 2,
                      mb: 0.5,
                      '&.Mui-selected': {
                        bgcolor: alpha(portal.accent, 0.12),
                        color: portal.accent,
                        '& .MuiListItemIcon-root': { color: portal.accent },
                        '&:hover': { bgcolor: alpha(portal.accent, 0.18) },
                      },
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 38 }}>
                      <Icon />
                    </ListItemIcon>
                    <ListItemText
                      primary={item.label}
                      primaryTypographyProps={{ fontWeight: active ? 700 : 500, fontSize: 14 }}
                    />
                  </ListItemButton>
                );
              })}
            </List>
          );
        })}
      </Box>
    </Box>
  );
}
