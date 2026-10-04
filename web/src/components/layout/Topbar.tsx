import { useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AppBar,
  Avatar,
  Badge,
  Box,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import MenuRoundedIcon from '@mui/icons-material/MenuRounded';
import NotificationsNoneRoundedIcon from '@mui/icons-material/NotificationsNoneRounded';
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded';
import LightModeRoundedIcon from '@mui/icons-material/LightModeRounded';
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import { useAuth } from '@/context/AuthContext';
import { useColorMode } from '@/context/ColorModeContext';
import { initials } from '@/utils/format';
import { DRAWER_WIDTH } from './Sidebar';

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { user, logout } = useAuth();
  const { mode, toggle } = useColorMode();
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  const openMenu = (e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget);
  const closeMenu = () => setAnchor(null);

  return (
    <AppBar
      position="fixed"
      color="inherit"
      elevation={0}
      sx={{
        width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
        ml: { md: `${DRAWER_WIDTH}px` },
        borderBottom: (t) => `1px solid ${t.palette.divider}`,
        backdropFilter: 'blur(8px)',
        bgcolor: (t) =>
          t.palette.mode === 'light' ? 'rgba(255,255,255,0.85)' : 'rgba(17,29,34,0.85)',
      }}
    >
      <Toolbar sx={{ gap: 1 }}>
        <IconButton edge="start" onClick={onMenuClick} sx={{ display: { md: 'none' } }}>
          <MenuRoundedIcon />
        </IconButton>

        <Box sx={{ flexGrow: 1 }} />

        <Tooltip title={mode === 'light' ? 'Dark mode' : 'Light mode'}>
          <IconButton onClick={toggle}>
            {mode === 'light' ? <DarkModeRoundedIcon /> : <LightModeRoundedIcon />}
          </IconButton>
        </Tooltip>

        <Tooltip title="Notifications">
          <IconButton>
            <Badge color="error" variant="dot">
              <NotificationsNoneRoundedIcon />
            </Badge>
          </IconButton>
        </Tooltip>

        <Divider orientation="vertical" flexItem sx={{ mx: 1, my: 1.5 }} />

        <Stack
          direction="row"
          spacing={1.25}
          alignItems="center"
          sx={{ cursor: 'pointer' }}
          onClick={openMenu}
        >
          <Avatar sx={{ bgcolor: user?.avatarColor, width: 36, height: 36, fontSize: 14 }}>
            {user ? initials(user.name) : '?'}
          </Avatar>
          <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
            <Typography variant="subtitle2" lineHeight={1.1}>
              {user?.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {user?.roleName}
            </Typography>
          </Box>
        </Stack>

        <Menu anchorEl={anchor} open={!!anchor} onClose={closeMenu} keepMounted>
          <MenuItem
            onClick={() => {
              closeMenu();
              navigate('/');
            }}
          >
            <ListItemIcon>
              <SwapHorizRoundedIcon fontSize="small" />
            </ListItemIcon>
            Switch portal
          </MenuItem>
          <Divider />
          <MenuItem
            onClick={() => {
              closeMenu();
              logout();
              navigate('/');
            }}
          >
            <ListItemIcon>
              <LogoutRoundedIcon fontSize="small" />
            </ListItemIcon>
            Sign out
          </MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  );
}
