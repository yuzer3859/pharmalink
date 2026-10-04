import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { FullPageLoader } from '@/components/common/LoadingScreen';
import { useAuth } from '@/context/AuthContext';
import type { PermissionKey, PortalKey } from '@/types';
import { PORTALS } from '@/config/navigation';

export function RequirePortal({ portal, children }: { portal: PortalKey; children: ReactNode }) {
  const { user, isInitializing } = useAuth();
  if (isInitializing) return <FullPageLoader />;
  if (!user) return <Navigate to="/" replace />;
  if (user.portal !== portal) return <Navigate to={PORTALS[user.portal].basePath} replace />;
  return <>{children}</>;
}

export function RequirePermission({
  permission,
  children,
}: {
  permission: PermissionKey;
  children: ReactNode;
}) {
  const { user, isInitializing, can } = useAuth();
  if (isInitializing) return <FullPageLoader />;
  if (!user) return <Navigate to="/" replace />;
  if (!can(permission)) return <Navigate to={`${PORTALS[user.portal].basePath}/dashboard`} replace />;
  return <>{children}</>;
}
