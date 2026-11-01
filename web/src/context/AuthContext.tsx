import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthUser, PermissionKey, PortalKey } from '@/types';
import {
  authService,
  getAuthErrorMessage,
  MfaRequiredError,
  PortalAccessError,
  type LoginCredentials,
  type MfaChallenge,
  type MfaEnrollment,
} from '@/services/auth.service';
import type { DataScope } from '@/services/scope';

interface AuthContextValue {
  user: AuthUser | null;
  scope: DataScope | null;
  isInitializing: boolean;
  authError: string | null;
  /** Throws `MfaRequiredError` with the next step when the account is an administrator. */
  login: (credentials: LoginCredentials) => Promise<AuthUser>;
  startMfaEnrollment: (challengeToken: string) => Promise<MfaEnrollment>;
  /**
   * Opens the session but does not sign the user in to the portal yet, so the one-time recovery
   * codes are always shown first. Call `acceptSession` once they are saved.
   */
  confirmMfaEnrollment: (challengeToken: string, code: string) => Promise<{ user: AuthUser; recoveryCodes: string[] }>;
  verifyMfa: (challengeToken: string, code: string, portal?: PortalKey) => Promise<AuthUser>;
  redeemRecoveryCode: (challengeToken: string, recoveryCode: string) => Promise<MfaChallenge>;
  acceptSession: (user: AuthUser, portal?: PortalKey) => Promise<AuthUser>;
  logout: () => Promise<void>;
  clearAuthError: () => void;
  can: (permission: PermissionKey) => boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = authService.subscribeToSessionExpiry(() => {
      if (!mounted) return;
      setUser(null);
      setAuthError('Your session expired. Please sign in again.');
    });

    void authService
      .restoreSession()
      .then((restoredUser) => {
        if (mounted) setUser(restoredUser);
      })
      .catch((error: unknown) => {
        if (mounted) {
          setUser(null);
          setAuthError(getAuthErrorMessage(error));
        }
      })
      .finally(() => {
        if (mounted) setIsInitializing(false);
      });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (credentials: LoginCredentials) => {
    setAuthError(null);
    try {
      const authenticatedUser = await ensurePortal(await authService.login(credentials), credentials.portal);
      setUser(authenticatedUser);
      return authenticatedUser;
    } catch (error) {
      if (!(error instanceof MfaRequiredError)) setAuthError(getAuthErrorMessage(error));
      throw error;
    }
  }, []);

  const startMfaEnrollment = useCallback((challengeToken: string) => authService.startMfaEnrollment(challengeToken), []);

  const confirmMfaEnrollment = useCallback(
    (challengeToken: string, code: string) => authService.confirmMfaEnrollment(challengeToken, code),
    [],
  );

  const verifyMfa = useCallback(async (challengeToken: string, code: string, portal?: PortalKey) => {
    const authenticatedUser = await ensurePortal(await authService.verifyMfa(challengeToken, code), portal);
    setUser(authenticatedUser);
    return authenticatedUser;
  }, []);

  const redeemRecoveryCode = useCallback(
    (challengeToken: string, recoveryCode: string) => authService.redeemRecoveryCode(challengeToken, recoveryCode),
    [],
  );

  const acceptSession = useCallback(async (authenticatedUser: AuthUser, portal?: PortalKey) => {
    setAuthError(null);
    const accepted = await ensurePortal(authenticatedUser, portal);
    setUser(accepted);
    return accepted;
  }, []);

  const logout = useCallback(async () => {
    await authService.logout();
    setUser(null);
    setAuthError(null);
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const can = useCallback(
    (permission: PermissionKey) => !!user?.permissions.includes(permission),
    [user],
  );

  const scope: DataScope | null = useMemo(
    () => (user ? { portal: user.portal, pharmacyId: user.pharmacyId } : null),
    [user],
  );

  const value = useMemo(
    () => ({
      user,
      scope,
      isInitializing,
      authError,
      login,
      startMfaEnrollment,
      confirmMfaEnrollment,
      verifyMfa,
      redeemRecoveryCode,
      acceptSession,
      logout,
      clearAuthError,
      can,
    }),
    [
      user,
      scope,
      isInitializing,
      authError,
      login,
      startMfaEnrollment,
      confirmMfaEnrollment,
      verifyMfa,
      redeemRecoveryCode,
      acceptSession,
      logout,
      clearAuthError,
      can,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** The portal the user picked is only a destination; the server decided who they are. */
async function ensurePortal(authenticatedUser: AuthUser, portal?: PortalKey): Promise<AuthUser> {
  if (portal && authenticatedUser.portal !== portal) {
    await authService.logout();
    throw new PortalAccessError(portal);
  }
  return authenticatedUser;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
