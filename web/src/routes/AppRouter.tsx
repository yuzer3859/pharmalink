import { Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PortalSelectPage } from '@/features/auth/PortalSelectPage';
import { NotFoundPage } from '@/features/misc/NotFoundPage';
import { RequirePermission, RequirePortal } from './guards';
import { PAGE_REGISTRY } from './pageRegistry';
import { PORTALS } from '@/config/navigation';
import type { PortalKey } from '@/types';

function PortalRoutes({ portalKey }: { portalKey: PortalKey }) {
  return (
    <RequirePortal portal={portalKey}>
      <DashboardLayout />
    </RequirePortal>
  );
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<PortalSelectPage />} />

      {(Object.keys(PORTALS) as PortalKey[]).map((portalKey) => {
        const portal = PORTALS[portalKey];
        return (
          <Route key={portalKey} path={portal.basePath} element={<PortalRoutes portalKey={portalKey} />}>
            <Route index element={<Navigate to="dashboard" replace />} />
            {portal.nav.map((item) => {
              const Page = PAGE_REGISTRY[item.path];
              if (!Page) return null;
              return (
                <Route
                  key={item.path}
                  path={item.path}
                  element={
                    <RequirePermission permission={item.permission}>
                      <Page />
                    </RequirePermission>
                  }
                />
              );
            })}
          </Route>
        );
      })}

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
