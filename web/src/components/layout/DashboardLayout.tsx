import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Box, Drawer, Toolbar } from '@mui/material';
import { useAuth } from '@/context/AuthContext';
import { PORTALS } from '@/config/navigation';
import { useRxRequestAlert } from '@/hooks/usePharmacyRxRequests';
import { DRAWER_WIDTH, SidebarContent } from './Sidebar';
import { RxRequestAlert } from './RxRequestAlert';
import { Topbar } from './Topbar';

const RX_REQUESTS_PATH = 'rx-requests';

export function DashboardLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, can } = useAuth();
  const location = useLocation();

  // Work 140: prescription requests waiting for the pharmacy, on every page of its portal.
  const rxAlertOn = user?.portal === 'pharmacy' && can('orders:view');
  const waiting = useRxRequestAlert(rxAlertOn);
  const rxRequestsTo = `${PORTALS.pharmacy.basePath}/${RX_REQUESTS_PATH}`;
  const onRxRequests = location.pathname.startsWith(rxRequestsTo);
  const badges = { [RX_REQUESTS_PATH]: waiting.toAnswer + waiting.toQuote };

  // The count in the tab title, so a pharmacist working in another tab sees it too.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = waiting.toAnswer > 0 ? `(${waiting.toAnswer}) ${base}` : base;
  }, [waiting.toAnswer, location.pathname]);

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Topbar onMenuClick={() => setMobileOpen((v) => !v)} />

      <Box component="nav" sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}>
        {/* Mobile temporary drawer */}
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: 'block', md: 'none' },
            '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
          }}
        >
          <SidebarContent onNavigate={() => setMobileOpen(false)} badges={badges} />
        </Drawer>

        {/* Desktop permanent drawer */}
        <Drawer
          variant="permanent"
          open
          sx={{
            display: { xs: 'none', md: 'block' },
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              borderRight: (t) => `1px solid ${t.palette.divider}`,
            },
          }}
        >
          <SidebarContent badges={badges} />
        </Drawer>
      </Box>

      <Box component="main" sx={{ flexGrow: 1, width: { md: `calc(100% - ${DRAWER_WIDTH}px)` } }}>
        <Toolbar />
        <Box sx={{ p: { xs: 2, sm: 3 } }}>
          {rxAlertOn && !onRxRequests ? <RxRequestAlert toAnswer={waiting.toAnswer} toQuote={waiting.toQuote} to={rxRequestsTo} /> : null}
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
