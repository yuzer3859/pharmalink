import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthUser, PermissionKey } from '@/types';
import {
  authService,
  getAuthErrorMessage,
  OtpRequiredError,
  PortalAccessError,
  type LoginCredentials,
  type OtpCredentials,
} from '@/services/auth.service';
import type { DataScope } from '@/services/scope';

interface AuthContextValue {
  user: AuthUser | null;
  scope: DataScope | null;
  isInitializing: boolean;
  authError: string | null;
  login: (credentials: LoginCredentials) => Promise<AuthUser>;
  verifyOtp: (credentials: OtpCredentials) => Promise<AuthUser>;
  resendOtp: (identifier: string) => Promise<void>;
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
      const authenticatedUser = await authService.login(credentials);
      if (credentials.portal && authenticatedUser.portal !== credentials.portal) {
        await authService.logout();
        throw new PortalAccessError(credentials.portal);
      }
      setUser(authenticatedUser);
      return authenticatedUser;
    } catch (error) {
      if (!(error instanceof OtpRequiredError)) setAuthError(getAuthErrorMessage(error));
      throw error;
    }
  }, []);

  const verifyOtp = useCallback(async (credentials: OtpCredentials) => {
    setAuthError(null);
    try {
      const authenticatedUser = await authService.verifyOtp(credentials);
      if (credentials.portal && authenticatedUser.portal !== credentials.portal) {
        await authService.logout();
        throw new PortalAccessError(credentials.portal);
      }
      setUser(authenticatedUser);
      return authenticatedUser;
    } catch (error) {
      setAuthError(getAuthErrorMessage(error));
      throw error;
    }
  }, []);

  const resendOtp = useCallback(async (identifier: string) => {
    setAuthError(null);
    try {
      await authService.resendOtp(identifier);
    } catch (error) {
      setAuthError(getAuthErrorMessage(error));
      throw error;
    }
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
      verifyOtp,
      resendOtp,
      logout,
      clearAuthError,
      can,
    }),
    [user, scope, isInitializing, authError, login, verifyOtp, resendOtp, logout, clearAuthError, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
