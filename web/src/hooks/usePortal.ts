import { useAuth } from '@/context/AuthContext';
import { PORTALS, type PortalDefinition } from '@/config/navigation';

// Convenience accessor for the active portal definition.
export function usePortal(): PortalDefinition {
  const { user } = useAuth();
  return PORTALS[user?.portal ?? 'pharmacy'];
}
